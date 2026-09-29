import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import type { SessionScope, VerificationPurpose } from "@envoy/db";
import { DEFAULT_FEATURE_ACCESS } from "@envoy/types";
import { BillingService } from "../../billing/billing.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { sendEmail } from "../common/resend.js";
import type { JwtPayload } from "./types.js";

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Two tabs refreshing at the same moment both present the same token; the
 * slower one would otherwise look like token theft and sign the user out
 * everywhere. Within this window a just-rotated token still mints a session.
 */
const REUSE_GRACE_MS = 30_000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; tenantId: string | null; role: string; emailVerified: boolean };
}

/** AuthResult for the response body, plus the refresh token the controller puts in an httpOnly cookie. */
export interface IssuedSession {
  result: AuthResult;
  refreshToken: string;
  expiresAt: Date;
}

type SessionUser = { id: string; email: string; tenantId: string | null; role: string; emailVerifiedAt: Date | null };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly billing: BillingService,
  ) {}

  /** Creates a new tenant workspace plus its first owner user and starter subscription. */
  async registerTenant(params: {
    tenantName: string;
    email: string;
    password: string;
  }, scope: SessionScope): Promise<IssuedSession> {
    const existing = await this.prisma.client.user.findUnique({
      where: { email: params.email },
    });
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);

    const tenant = await this.prisma.client.tenant.create({
      data: {
        name: params.tenantName,
        users: {
          create: {
            email: params.email,
            passwordHash,
            role: "owner",
            featureAccess: DEFAULT_FEATURE_ACCESS,
          },
        },
      },
      include: { users: true },
    });
    await this.billing.ensureSubscription(tenant.id);
    const owner = tenant.users[0]!;
    // Fire-and-forget: a slow or failing mail provider must never block
    // signup. Same posture as the mock-fallback senders elsewhere.
    void this.requestEmailVerification(owner.id).catch(() => {});

    return this.issueSession(owner, scope);
  }

  /**
   * Seeds a platform_admin user. Gated by a bootstrap secret rather than
   * open registration — there's no "first admin" UI flow yet, so this is
   * the deliberately narrow door: whoever holds ADMIN_BOOTSTRAP_SECRET (an
   * env var, not stored anywhere) can mint an operator account.
   */
  async registerAdmin(params: {
    email: string;
    password: string;
    bootstrapSecret: string;
  }, scope: SessionScope): Promise<IssuedSession> {
    const expected = process.env.ADMIN_BOOTSTRAP_SECRET;
    if (!expected || params.bootstrapSecret !== expected) {
      throw new ForbiddenException("Invalid bootstrap secret");
    }
    const existing = await this.prisma.client.user.findUnique({ where: { email: params.email } });
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
    const admin = await this.prisma.client.user.create({
      data: { email: params.email, passwordHash, role: "platform_admin", tenantId: null },
    });
    return this.issueSession(admin, scope);
  }

  async login(email: string, password: string, scope: SessionScope): Promise<IssuedSession> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return this.issueSession(user, scope);
  }

  /**
   * Swaps a refresh token for a new access token + a new refresh token
   * (rotation). Claims are rebuilt from the database, so a role or tenant
   * change — or a deleted user — takes effect at the next refresh.
   */
  async refresh(refreshToken: string | undefined, scope: SessionScope): Promise<IssuedSession> {
    if (!refreshToken) throw new UnauthorizedException("No session");
    const session = await this.prisma.client.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { user: true },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now || session.appScope !== scope) {
      throw new UnauthorizedException("Session expired — sign in again");
    }

    if (session.rotatedAt && now - session.rotatedAt.getTime() > REUSE_GRACE_MS) {
      // An old, already-rotated token came back: someone else has a copy.
      // Kill every session for this user so the thief's copy dies too.
      await this.revokeAllSessions(session.userId);
      throw new UnauthorizedException("Session reuse detected — sign in again");
    }
    if (!session.rotatedAt) {
      await this.prisma.client.session.updateMany({
        where: { id: session.id, rotatedAt: null },
        data: { rotatedAt: new Date(now) },
      });
    }
    return this.issueSession(session.user, scope);
  }

  /** Revokes the session behind this refresh token (or every session for its user, across all apps). */
  async logout(refreshToken: string | undefined, scope: SessionScope, everywhere = false): Promise<void> {
    if (!refreshToken) return;
    const session = await this.prisma.client.session.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!session || session.appScope !== scope) return;
    if (everywhere) await this.revokeAllSessions(session.userId);
    else await this.prisma.client.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Always resolves the same way regardless of whether the email exists —
   * callers must not be able to use this to enumerate accounts. Returns the
   * raw token ONLY when no RESEND_API_KEY is configured (dev/test
   * convenience, same posture as the mock-mode senders); in production the
   * token only ever exists in the emailed link.
   */
  async requestPasswordReset(email: string): Promise<{ devToken?: string }> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user) return {};

    const token = await this.issueVerificationToken(user.id, "password_reset", RESET_TOKEN_TTL_MS);
    const link = new URL("/reset-password", process.env.PORTAL_URL ?? "http://localhost:3001");
    link.searchParams.set("token", token);
    await sendEmail(
      user.email,
      "Reset your Envoy password",
      `Use this link to set a new password (expires in 1 hour):\n\n${link.toString()}\n\nIf you didn't request this, you can ignore this email.`,
    );
    return process.env.RESEND_API_KEY ? {} : { devToken: token };
  }

  /** Sets a new password and, since the old one may be compromised, signs out every device. */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const userId = await this.consumeVerificationToken(token, "password_reset");
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.client.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.revokeAllSessions(userId);
  }

  /** Same dev-mode token exposure as requestPasswordReset — see its docstring. */
  async requestEmailVerification(userId: string): Promise<{ devToken?: string }> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerifiedAt) return {};

    const token = await this.issueVerificationToken(user.id, "email_verify", VERIFY_TOKEN_TTL_MS);
    const link = new URL("/verify-email", process.env.PORTAL_URL ?? "http://localhost:3001");
    link.searchParams.set("token", token);
    await sendEmail(
      user.email,
      "Verify your email",
      `Confirm your email address (expires in 24 hours):\n\n${link.toString()}`,
    );
    return process.env.RESEND_API_KEY ? {} : { devToken: token };
  }

  async confirmEmailVerification(token: string): Promise<void> {
    const userId = await this.consumeVerificationToken(token, "email_verify");
    await this.prisma.client.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  }

  private async issueVerificationToken(userId: string, purpose: VerificationPurpose, ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.prisma.client.verificationToken.create({
      data: { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return token;
  }

  private async consumeVerificationToken(token: string, purpose: VerificationPurpose): Promise<string> {
    const record = await this.prisma.client.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("This link is invalid or has expired");
    }
    await this.prisma.client.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record.userId;
  }

  private async issueSession(user: SessionUser, scope: SessionScope): Promise<IssuedSession> {
    const payload: JwtPayload = { sub: user.id, tenantId: user.tenantId, role: user.role as JwtPayload["role"] };
    const refreshToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.client.session.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), appScope: scope, expiresAt },
    });
    return {
      result: {
        accessToken: this.jwt.sign(payload, { expiresIn: "15m" }),
        user: {
          id: user.id,
          email: user.email,
          tenantId: user.tenantId,
          role: user.role,
          emailVerified: user.emailVerifiedAt !== null,
        },
      },
      refreshToken,
      expiresAt,
    };
  }
}
