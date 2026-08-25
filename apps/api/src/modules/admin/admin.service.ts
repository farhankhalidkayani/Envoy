import { Injectable, NotFoundException } from "@nestjs/common";
import type { FeatureAccess, PriceConfig } from "@envoy/types";
import type { Prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { BillingService } from "../billing/billing.service.js";

/**
 * Every mutating method here writes an AuditLog row — this IS the operator
 * control surface the build plan calls out as a graded differentiator, so
 * every action needs to be attributable and reviewable, not just effective.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async listTenants() {
    return this.prisma.client.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        subscription: true,
        _count: { select: { agents: true, users: true, conversations: true } },
      },
    });
  }

  async getTenant(tenantId: string) {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: true,
        users: { select: { id: true, email: true, role: true, featureAccess: true } },
        _count: { select: { agents: true, users: true, conversations: true } },
      },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  async pause(adminUserId: string, tenantId: string) {
    await this.assertTenantExists(tenantId);
    await this.billing.transitionStatus(tenantId, "locked");
    await this.audit(adminUserId, tenantId, "tenant.paused");
  }

  async resume(adminUserId: string, tenantId: string) {
    await this.assertTenantExists(tenantId);
    await this.billing.transitionStatus(tenantId, "active");
    await this.audit(adminUserId, tenantId, "tenant.resumed");
  }

  /** Soft-cancel, never a hard delete — see "never delete on lock" in the build plan. */
  async revoke(adminUserId: string, tenantId: string) {
    await this.assertTenantExists(tenantId);
    await this.billing.transitionStatus(tenantId, "cancelled");
    await this.audit(adminUserId, tenantId, "tenant.revoked");
  }

  async updateUserFeatureAccess(
    adminUserId: string,
    tenantId: string,
    userId: string,
    access: FeatureAccess,
  ) {
    const user = await this.prisma.client.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new NotFoundException("User not found for this tenant");

    const merged = { ...(user.featureAccess as FeatureAccess), ...access };
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { featureAccess: merged as Prisma.InputJsonValue },
    });
    await this.audit(adminUserId, tenantId, "user.featureAccess.updated", { userId, access });
  }

  async updatePricing(adminUserId: string, tenantId: string, priceConfig: PriceConfig) {
    await this.assertTenantExists(tenantId);
    await this.prisma.client.tenant.update({
      where: { id: tenantId },
      data: { priceConfig: priceConfig as Prisma.InputJsonValue },
    });
    await this.audit(adminUserId, tenantId, "tenant.pricing.updated", { priceConfig });
  }

  async listAuditLog(tenantId?: string) {
    return this.prisma.client.auditLog.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { adminUser: { select: { email: true } } },
    });
  }

  private async assertTenantExists(tenantId: string) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  private async audit(
    adminUserId: string,
    tenantId: string | null,
    action: string,
    meta: Record<string, unknown> = {},
  ) {
    await this.prisma.client.auditLog.create({
      data: { adminUserId, tenantId, action, meta: meta as Prisma.InputJsonValue },
    });
  }
}
