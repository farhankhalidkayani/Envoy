import { Injectable } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * One log for every consequential action, whether the actor is a platform
 * operator (apps/api/src/modules/admin/admin.service.ts's private `audit`
 * helper predates this and is admin-module-scoped) or a tenant user acting
 * on their own account (CRM/integrations connect, form publish, etc.).
 * `adminUserId` is a generic actor-id FK to User — the name is legacy from
 * when only admin actions were logged; nothing about the column restricts
 * it to the platform_admin role.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(actorUserId: string, tenantId: string | null, action: string, meta: Record<string, unknown> = {}) {
    await this.prisma.client.auditLog.create({
      data: { adminUserId: actorUserId, tenantId, action, meta: meta as Prisma.InputJsonValue },
    });
  }
}
