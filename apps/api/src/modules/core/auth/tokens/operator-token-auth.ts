import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { decideOperatorAccess } from "@envoy/types";
import { enforceRateLimit } from "../../common/rate-limit.js";
import type { PrismaService } from "../../prisma/prisma.service.js";
import type { RedisService } from "../../redis/redis.service.js";
import type { AuthenticatedRequest } from "../types.js";
import { hashToken } from "./api-token-auth.js";

export const OPERATOR_TOKEN_REQUESTS_PER_MINUTE = 60;

/**
 * Validates an `envoy_op_…` operator token. It acts as the platform admin who created it — but only while they are
 * still a platform admin — and only on the short allow-list in decideOperatorAccess. Refused writes are audited.
 */
export async function authenticateOperatorToken(prisma: PrismaService, redis: RedisService, secret: string, req: AuthenticatedRequest & { originalUrl: string }): Promise<true> {
  const token = await prisma.client.operatorToken.findUnique({ where: { tokenHash: hashToken(secret) }, include: { user: { select: { id: true, role: true } } } });
  if (!token || token.revokedAt || token.expiresAt.getTime() <= Date.now() || token.user.role !== "platform_admin") {
    throw new UnauthorizedException("Invalid, expired or revoked operator token");
  }
  await enforceRateLimit(redis.client, `optoken:${token.id}`, OPERATOR_TOKEN_REQUESTS_PER_MINUTE, 60);

  const decision = decideOperatorAccess(req.method, req.originalUrl, token.scopes);
  if (!decision.allowed) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      void prisma.client.auditLog
        .create({ data: { adminUserId: token.user.id, action: "operator_token.request", meta: { tokenId: token.id, token: token.name, method: req.method, path: req.originalUrl.split("?")[0], status: 403 } } })
        .catch(() => {});
    }
    throw new ForbiddenException(decision.reason);
  }

  req.user = { sub: token.user.id, tenantId: null, role: "platform_admin" };
  // The audit interceptor records every change made through a token, operator tokens included.
  req.apiToken = { id: token.id, name: token.name, scopes: token.scopes, operator: true };
  if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60_000) {
    void prisma.client.operatorToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return true;
}
