import { randomBytes } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { API_TOKEN_PREFIX, type CreateApiTokenInput } from "@envoy/types";
import { PrismaService } from "../../prisma/prisma.service.js";
import { hashToken } from "./api-token-auth.js";

const MAX_ACTIVE_TOKENS = 20;

@Injectable()
export class TokensService {
  constructor(private readonly prisma: PrismaService) {}

  private view(t: { id: string; name: string; last4: string; scopes: string[]; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; userId: string }) {
    // The hash is deliberately not part of this shape — and the secret is only ever returned by create().
    return { id: t.id, name: t.name, last4: t.last4, scopes: t.scopes, expiresAt: t.expiresAt, revokedAt: t.revokedAt, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt, createdBy: t.userId };
  }

  async list(tenantId: string) {
    const rows = await this.prisma.client.apiToken.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.view(r));
  }

  /** The secret is shown once, here, and never again — only its hash is kept. */
  async create(tenantId: string, userId: string, input: CreateApiTokenInput) {
    const active = await this.prisma.client.apiToken.count({ where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (active >= MAX_ACTIVE_TOKENS) throw new BadRequestException(`You can have at most ${MAX_ACTIVE_TOKENS} active API tokens. Revoke one first.`);

    const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.client.apiToken.create({
      data: {
        tenantId,
        userId,
        name: input.name,
        scopes: [...new Set(input.scopes)],
        tokenHash: hashToken(secret),
        last4: secret.slice(-4),
        expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
      },
    });
    await this.prisma.client.auditLog.create({ data: { adminUserId: userId, tenantId, action: "api_token.created", meta: { tokenId: row.id, name: row.name, scopes: row.scopes } } });
    return { ...this.view(row), token: secret };
  }

  async revoke(tenantId: string, userId: string, id: string) {
    const token = await this.prisma.client.apiToken.findFirst({ where: { id, tenantId } });
    if (!token) throw new NotFoundException("Token not found");
    if (!token.revokedAt) {
      await this.prisma.client.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.prisma.client.auditLog.create({ data: { adminUserId: userId, tenantId, action: "api_token.revoked", meta: { tokenId: id, name: token.name } } });
    }
    return { revoked: true };
  }
}
