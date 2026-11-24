import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { API_TOKEN_PREFIX } from "@envoy/types";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RedisService } from "../../redis/redis.service.js";
import { authenticateApiToken } from "../tokens/api-token-auth.js";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Authenticates a request as a signed-in user — by short-lived JWT (the
 * portal and admin console) or by an `envoy_sk_` API token (scripts and AI
 * agents). Either way the result is the same `req.user`, so every guard and
 * service downstream (tenant scope, roles, feature flags, tenant lock) applies
 * to both identically. Prisma and Redis are global providers, so this guard
 * resolves wherever it is used.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest & { originalUrl: string; headers: Record<string, string | undefined> }>();
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (bearer?.startsWith(API_TOKEN_PREFIX)) return authenticateApiToken(this.prisma, this.redis, bearer, req);
    return (await super.canActivate(context)) as boolean;
  }
}
