import { Body, Controller, HttpCode, Ip, Post, Query, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { enforceRateLimit } from "../common/rate-limit.js";
import { RedisService } from "../redis/redis.service.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { AuthService, type IssuedSession } from "./auth.service.js";
import type { JwtPayload } from "./types.js";
import { appScopeOf, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./refresh-cookie.js";

const RequestPasswordResetDto = z.object({ email: z.string().email() });
const ConfirmPasswordResetDto = z.object({ token: z.string().min(1), password: z.string().min(8) });
const ConfirmEmailVerificationDto = z.object({ token: z.string().min(1) });

const RegisterDto = z.object({
  tenantName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const LoginDto = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RegisterAdminDto = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  bootstrapSecret: z.string().min(1),
});

/**
 * Every successful sign-in returns a 15-minute access token in the body and
 * a 30-day rotating refresh token in an httpOnly cookie (see
 * refresh-cookie.ts). The client calls /auth/refresh when the access token
 * expires instead of sending the user back to the login page.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly redis: RedisService,
  ) {}

  private respond(req: Request, res: Response, session: IssuedSession) {
    setRefreshCookie(res, appScopeOf(req), session.refreshToken, session.expiresAt);
    return session.result;
  }

  @Post("register")
  async register(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(RegisterDto)) body: z.infer<typeof RegisterDto>,
  ) {
    return this.respond(req, res, await this.auth.registerTenant(body, appScopeOf(req)));
  }

  @Post("login")
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(LoginDto)) body: z.infer<typeof LoginDto>,
  ) {
    // Two limits: per IP (catches spraying many emails from one source) and
    // per email (catches distributed guessing at a single account) — a
    // request only needs to trip one to be blocked. Counted on every
    // attempt, not just failures, so an attacker can't burn only the
    // (cheap) failure path to dodge the limit.
    await enforceRateLimit(this.redis.client, `login-ip:${ip}`, 30, 600);
    await enforceRateLimit(this.redis.client, `login-email:${body.email.toLowerCase()}`, 8, 600);
    return this.respond(req, res, await this.auth.login(body.email, body.password, appScopeOf(req)));
  }

  @Post("register-admin")
  async registerAdmin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(RegisterAdminDto)) body: z.infer<typeof RegisterAdminDto>,
  ) {
    return this.respond(req, res, await this.auth.registerAdmin(body, appScopeOf(req)));
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const scope = appScopeOf(req);
    try {
      return this.respond(req, res, await this.auth.refresh(readRefreshCookie(req, scope), scope));
    } catch (err) {
      if (err instanceof UnauthorizedException) clearRefreshCookie(res, scope);
      throw err;
    }
  }

  /** `?everywhere=true` signs out every device (and every app) for this user. */
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query("everywhere") everywhere?: string,
  ) {
    const scope = appScopeOf(req);
    await this.auth.logout(readRefreshCookie(req, scope), scope, everywhere === "true");
    clearRefreshCookie(res, scope);
  }

  /** Always 200 whether or not the email exists — the response must not reveal which. */
  @Post("password-reset/request")
  @HttpCode(200)
  async requestPasswordReset(
    @Ip() ip: string,
    @Body(new ZodValidationPipe(RequestPasswordResetDto)) body: z.infer<typeof RequestPasswordResetDto>,
  ) {
    await enforceRateLimit(this.redis.client, `pwreset-ip:${ip}`, 10, 3600);
    await enforceRateLimit(this.redis.client, `pwreset-email:${body.email.toLowerCase()}`, 5, 3600);
    const { devToken } = await this.auth.requestPasswordReset(body.email);
    return { requested: true, ...(devToken ? { devToken } : {}) };
  }

  @Post("password-reset/confirm")
  @HttpCode(200)
  async confirmPasswordReset(@Body(new ZodValidationPipe(ConfirmPasswordResetDto)) body: z.infer<typeof ConfirmPasswordResetDto>) {
    await this.auth.confirmPasswordReset(body.token, body.password);
    return { reset: true };
  }

  /** Resend the verification email for the signed-in user. */
  @Post("verify-email/request")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async requestEmailVerification(@CurrentUser() user: JwtPayload) {
    const { devToken } = await this.auth.requestEmailVerification(user.sub);
    return { requested: true, ...(devToken ? { devToken } : {}) };
  }

  @Post("verify-email/confirm")
  @HttpCode(200)
  async confirmEmailVerification(
    @Body(new ZodValidationPipe(ConfirmEmailVerificationDto)) body: z.infer<typeof ConfirmEmailVerificationDto>,
  ) {
    await this.auth.confirmEmailVerification(body.token);
    return { verified: true };
  }
}
