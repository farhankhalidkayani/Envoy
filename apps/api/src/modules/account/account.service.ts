import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Just enough for the settings page to render — the delete confirmation needs the tenant's exact name. */
  async getInfo(tenantId: string) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  /** Everything the tenant owns, minus encrypted OAuth secrets — those aren't the customer's data to export. */
  async exportData(tenantId: string) {
    const [tenant, agents, conversations, forms, formSubmissions, crmConnections, integrations] = await Promise.all([
      this.prisma.client.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.client.agent.findMany({ where: { tenantId } }),
      this.prisma.client.conversation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
      this.prisma.client.form.findMany({ where: { tenantId } }),
      this.prisma.client.formSubmission.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
      this.prisma.client.crmConnection.findMany({ where: { tenantId } }),
      this.prisma.client.integration.findMany({ where: { tenantId } }),
    ]);
    if (!tenant) throw new NotFoundException("Tenant not found");

    return {
      exportedAt: new Date().toISOString(),
      tenant: { id: tenant.id, name: tenant.name, industry: tenant.industry, createdAt: tenant.createdAt },
      agents,
      conversations,
      forms,
      formSubmissions,
      crmConnections: crmConnections.map(({ oauthTokens: _t, ...rest }) => rest),
      integrations: integrations.map(({ oauthTokens: _t, ...rest }) => rest),
    };
  }

  /**
   * Irreversible — cascades to every row scoped to this tenant (see the
   * Tenant model's relations, all onDelete: Cascade except AuditLog, which
   * survives with tenantId nulled out). No AuditLog row is written for a
   * self-delete: the acting user's own row cascades away with the tenant,
   * so an AuditLog entry pointing at them wouldn't survive either — logged
   * to the server log instead.
   */
  async deleteAccount(tenantId: string, requestedByUserId: string, confirmName: string) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    if (confirmName !== tenant.name) {
      throw new BadRequestException("Type the exact business name to confirm deletion");
    }
    this.logger.warn(`tenant ${tenantId} ("${tenant.name}") self-deleted by user ${requestedByUserId}`);
    await this.prisma.client.tenant.delete({ where: { id: tenantId } });
  }
}
