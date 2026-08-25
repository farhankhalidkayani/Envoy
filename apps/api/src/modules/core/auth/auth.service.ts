import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { DEFAULT_FEATURE_ACCESS } from "@envoy/types";
import { BillingService } from "../../billing/billing.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { JwtPayload } from "./types.js";

const BCRYPT_ROUNDS = 12;

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; tenantId: string | null; role: string };
}

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
  }): Promise<AuthResult> {
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
    return this.issueTokens({ sub: owner.id, tenantId: tenant.id, role: "owner" }, owner.email);
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
  }): Promise<AuthResult> {
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
    return this.issueTokens({ sub: admin.id, tenantId: null, role: "platform_admin" }, admin.email);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return this.issueTokens(
      { sub: user.id, tenantId: user.tenantId, role: user.role },
      user.email,
    );
  }

  private issueTokens(payload: JwtPayload, email: string): AuthResult {
    const accessToken = this.jwt.sign(payload, { expiresIn: "15m" });
    return {
      accessToken,
      user: { id: payload.sub, email, tenantId: payload.tenantId, role: payload.role },
    };
  }
}
