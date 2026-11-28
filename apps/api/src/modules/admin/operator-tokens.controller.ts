import { randomBytes } from "node:crypto";
import { Body, Controller, Delete, Get, Injectable, NotFoundException, Param, Post, UseGuards, BadRequestException } from "@nestjs/common";
import { CreateOperatorTokenInput, OPERATOR_TOKEN_PREFIX } from "@envoy/types";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { Roles } from "../core/auth/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../core/auth/guards/roles.guard.js";
import { hashToken } from "../core/auth/tokens/api-token-auth.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { PrismaService } from "../core/prisma/prisma.service.js";

const MAX_ACTIVE = 5;

@Injectable()
export class OperatorTokensService {
  constructor(private readonly prisma: PrismaService) {}

  private view(t: { id: string; name: string; last4: string; scopes: string[]; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; userId: string }) {
    return { id: t.id, name: t.name, last4: t.last4, scopes: t.scopes, expiresAt: t.expiresAt, revokedAt: t.revokedAt, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt, createdBy: t.userId };
  }

  async list() {
    return (await this.prisma.client.operatorToken.findMany({ orderBy: { createdAt: "desc" }, take: 100 })).map((t) => this.view(t));
  }

  async create(userId: string, input: CreateOperatorTokenInput) {
    if ((await this.prisma.client.operatorToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } })) >= MAX_ACTIVE) {
      throw new BadRequestException(`At most ${MAX_ACTIVE} operator tokens can be active. Revoke one first.`);
    }
    const secret = `${OPERATOR_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.client.operatorToken.create({
      data: { userId, name: input.name, scopes: [...new Set(input.scopes)], tokenHash: hashToken(secret), last4: secret.slice(-4), expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) },
    });
    await this.prisma.client.auditLog.create({ data: { adminUserId: userId, action: "operator_token.created", meta: { tokenId: row.id, name: row.name, scopes: row.scopes } } });
    return { ...this.view(row), token: secret };
  }

  async revoke(userId: string, id: string) {
    const token = await this.prisma.client.operatorToken.findUnique({ where: { id } });
    if (!token) throw new NotFoundException("Token not found");
    if (!token.revokedAt) {
      await this.prisma.client.operatorToken.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.prisma.client.auditLog.create({ data: { adminUserId: userId, action: "operator_token.revoked", meta: { tokenId: id, name: token.name } } });
    }
    return { revoked: true };
  }
}

/**
 * Platform admins manage the operator tokens their AI assistant uses — signed in as a person. Operator tokens are
 * refused here by policy, and workspace tokens can't reach /admin at all.
 */
@Controller("admin/operator-tokens")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("platform_admin")
export class OperatorTokensController {
  constructor(private readonly tokens: OperatorTokensService) {}

  @Get()
  list() {
    return this.tokens.list();
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(CreateOperatorTokenInput)) body: CreateOperatorTokenInput) {
    return this.tokens.create(user.sub, body);
  }

  @Delete(":id")
  revoke(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.tokens.revoke(user.sub, id);
  }
}
