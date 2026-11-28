import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, UseGuards } from "@nestjs/common";
import { RegisterClientInput } from "@envoy/types";
import { enforceRateLimit } from "../../common/rate-limit.js";
import { RedisService } from "../../redis/redis.service.js";
import { CurrentUser } from "../decorators/current-user.decorator.js";
import { Roles } from "../decorators/roles.decorator.js";
import { JwtAuthGuard } from "../guards/jwt-auth.guard.js";
import { RolesGuard } from "../guards/roles.guard.js";
import { TenantScopeGuard } from "../guards/tenant-scope.guard.js";
import type { JwtPayload } from "../types.js";
import { OAuthError, OAuthService } from "./oauth.service.js";

const REGISTRATIONS_PER_HOUR_PER_IP = 20;
const TOKEN_REQUESTS_PER_MINUTE_PER_IP = 60;

/** Discovery: what an MCP client reads to learn how to sign in here (RFC 8414). */
@Controller(".well-known")
export class OAuthMetadataController {
  constructor(private readonly oauth: OAuthService) {}

  @Get("oauth-authorization-server")
  metadata() {
    return this.oauth.metadata();
  }
}

@Controller("oauth")
export class OAuthController {
  constructor(private readonly oauth: OAuthService, private readonly redis: RedisService) {}

  /** Open (that's the point of dynamic registration), so rate-limited per address. A client can do nothing until a person approves it. */
  @Post("register")
  @Header("Cache-Control", "no-store")
  async register(@Req() req: { ip?: string }, @Body() body: unknown) {
    await enforceRateLimit(this.redis.client, `oauth-register:${req.ip}`, REGISTRATIONS_PER_HOUR_PER_IP, 3600);
    const parsed = RegisterClientInput.safeParse(body);
    if (!parsed.success) throw new OAuthError("invalid_client_metadata", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return this.oauth.register(parsed.data);
  }

  /** Form-encoded per the spec; JSON is accepted too. */
  @Post("token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @Header("Pragma", "no-cache")
  async token(@Req() req: { ip?: string }, @Body() body: Record<string, unknown>) {
    await enforceRateLimit(this.redis.client, `oauth-token:${req.ip}`, TOKEN_REQUESTS_PER_MINUTE_PER_IP, 60);
    return this.oauth.token(body ?? {});
  }

  // ── the consent page (portal), signed in as the workspace owner. Tokens can't reach /oauth at all. ──

  @Get("authorize/describe")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, RolesGuard)
  @Roles("owner")
  describe(@Query() query: Record<string, unknown>) {
    return this.oauth.describe(query);
  }

  @Post("authorize")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, TenantScopeGuard, RolesGuard)
  @Roles("owner")
  approve(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    return this.oauth.approve(user.tenantId!, user.sub, body ?? {});
  }

  @Post("authorize/deny")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, TenantScopeGuard, RolesGuard)
  @Roles("owner")
  deny(@Body() body: Record<string, unknown>) {
    return this.oauth.deny(body ?? {});
  }
}
