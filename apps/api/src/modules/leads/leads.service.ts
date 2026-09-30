import { Injectable } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";

export type LeadSource = "conversation" | "form";

export interface Lead {
  id: string;
  source: LeadSource;
  sourceLabel: string;
  data: Record<string, unknown>;
  createdAt: Date;
  crmPushedAt: Date | null;
  crmPushError: string | null;
  integrationStatus: Record<string, { pushedAt?: string; error?: string }>;
}

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Merges completed conversations and form submissions into one
   * newest-first feed. No compound cursor across two heterogeneous
   * sources — "Load more" just re-fetches with a bigger `limit` from each
   * side and re-merges. Simple and correct as long as `limit` only grows;
   * a true cursor would need a k-way-merge cursor scheme that isn't worth
   * it at this scale.
   */
  async list(tenantId: string, limit = 50): Promise<{ leads: Lead[]; hasMore: boolean }> {
    const take = Math.min(Math.max(limit, 1), 500);
    const [conversations, submissions] = await Promise.all([
      this.prisma.client.conversation.findMany({
        where: { tenantId, status: "completed" },
        orderBy: { createdAt: "desc" },
        take,
        include: { agent: { select: { name: true } } },
      }),
      this.prisma.client.formSubmission.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take,
        include: { form: { select: { name: true } } },
      }),
    ]);

    const leads: Lead[] = [
      ...conversations.map((c) => ({
        id: c.id,
        source: "conversation" as const,
        sourceLabel: c.agent.name,
        data: c.capturedData as Record<string, unknown>,
        createdAt: c.createdAt,
        crmPushedAt: c.crmPushedAt,
        crmPushError: c.crmPushError,
        integrationStatus: c.integrationStatus as Record<string, { pushedAt?: string; error?: string }>,
      })),
      ...submissions.map((s) => ({
        id: s.id,
        source: "form" as const,
        sourceLabel: s.form.name,
        data: s.data as Record<string, unknown>,
        createdAt: s.createdAt,
        crmPushedAt: s.crmPushedAt,
        crmPushError: s.crmPushError,
        integrationStatus: s.integrationStatus as Record<string, { pushedAt?: string; error?: string }>,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      leads: leads.slice(0, take),
      // If either source came back full, there could be more beyond this page.
      hasMore: conversations.length === take || submissions.length === take,
    };
  }

  async stats(tenantId: string) {
    const [totalForms, liveForms, totalSubmissions, totalLeadConversations] = await Promise.all([
      this.prisma.client.form.count({ where: { tenantId } }),
      this.prisma.client.form.count({ where: { tenantId, status: "live" } }),
      this.prisma.client.formSubmission.count({ where: { tenantId } }),
      this.prisma.client.conversation.count({ where: { tenantId, status: "completed" } }),
    ]);
    return { totalForms, liveForms, totalSubmissions, totalLeadConversations };
  }
}
