import { createHash } from "node:crypto";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { decideTokenAccess } from "@envoy/types";
import type { PrismaService } from "../../prisma/prisma.service.js";
import type { RedisService } from "../../redis/redis.service.js";
import { enforceRateLimit } from "../../common/rate-limit.js";
import type { AuthenticatedRequest } from "../types.js";

export const hashToken = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Requests a token may make per minute. Generous for a person's AI assistant, tight enough that a runaway loop is stopped. */
export const API_TOKEN_REQUESTS_PER_MINUTE = 120;
const TOUCH_EVERY_MS = 60_000;

/**
 * Validates an `envoy_sk_…` bearer token and, if it's good, makes the request look like the user who created it —
 * minus everything the token isn't allowed to do. Throws 401 for a bad/expired/revoked token and 403 for a
 * request outside its scopes; both say as little as possible.
 */
export async function authenticateApiToken(prisma: PrismaService, redis: RedisService, secret: string, req: AuthenticatedRequest & { originalUrl: string }): Promise<true> {
  const token = await prisma.client.apiToken.findUnique({
    where: { tokenHash: hashToken(secret) },
    include: { user: { select: { id: true, tenantId: true, role: true } } },
  });
  if (!token || token.revokedAt || token.expiresAt.getTime() <= Date.now() || !token.user.tenantId) {
    throw new UnauthorizedException("Invalid, expired or revoked API token");
  }

  await enforceRateLimit(redis.client, `apitoken:${token.id}`, API_TOKEN_REQUESTS_PER_MINUTE, 60);

  const decision = decideTokenAccess(req.method, req.originalUrl, token.scopes);
  if (!decision.allowed) {
    // A refused change is exactly what an owner wants to see ("my AI tried to delete the account"). Reads aren't logged.
    if (req.method !== "GET" && req.method !== "HEAD") {
      void prisma.client.auditLog
        .create({
          data: {
            adminUserId: token.user.id,
            tenantId: token.tenantId,
            action: "api_token.request",
            meta: { tokenId: token.id, token: token.name, method: req.method, path: req.originalUrl.split("?")[0], status: 403 },
          },
        })
        .catch(() => {});
    }
    throw new ForbiddenException(decision.reason);
  }

  // A token acts as its user, with that user's CURRENT role — demoting or removing them narrows or ends the token.
  req.user = { sub: token.user.id, tenantId: token.user.tenantId, role: token.user.role };
  req.apiToken = { id: token.id, name: token.name, scopes: token.scopes };

  if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    void prisma.client.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return true;
}
