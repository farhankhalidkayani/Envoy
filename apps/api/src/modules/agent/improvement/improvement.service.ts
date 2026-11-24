import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { RequiredFieldsSpec, type InsightEvidence, type InsightStatus } from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { computeMetrics, detectInsights, type ConversationRow, type ToolStepRow } from "./analysis.js";

const MAX_CONVERSATIONS = 5000;
const MAX_TOOL_STEPS = 50_000;

/** Reads real conversations for an agent, tenant-scoped, and turns them into metrics and diagnosed insights. */
@Injectable()
export class ImprovementService {
  constructor(private readonly prisma: PrismaService) {}

  private async agentScoped(tenantId: string, agentId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId } });
    if (!agent) throw new NotFoundException("Agent not found");
    return agent;
  }

  private async load(tenantId: string, agentId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [rows, steps] = await Promise.all([
      this.prisma.client.conversation.findMany({
        where: { tenantId, agentId, createdAt: { gte: since }, status: { in: ["completed", "abandoned"] } },
        select: { id: true, status: true, agentVersion: true, handoffReason: true, turnCount: true, capturedData: true, ruleViolationsBlocked: true, transcriptText: true },
        orderBy: { createdAt: "desc" },
        take: MAX_CONVERSATIONS,
      }),
      this.prisma.client.agentRunStep.findMany({
        where: { tenantId, kind: "tool", conversation: { agentId, createdAt: { gte: since } } },
        select: { name: true, error: true, conversationId: true, conversation: { select: { agentVersion: true } } },
        take: MAX_TOOL_STEPS,
      }),
    ]);
    const conversations: ConversationRow[] = rows.map((c) => ({
      id: c.id,
      status: c.status,
      agentVersion: c.agentVersion,
      handoffReason: c.handoffReason,
      turnCount: c.turnCount,
      capturedData: (c.capturedData as Record<string, unknown>) ?? {},
      ruleViolationsBlocked: Array.isArray(c.ruleViolationsBlocked) ? (c.ruleViolationsBlocked as Array<{ ruleId?: string }>) : [],
      hasTranscript: c.transcriptText !== null,
    }));
    const toolSteps: ToolStepRow[] = steps.map((s) => ({ conversationId: s.conversationId, agentVersion: s.conversation.agentVersion, name: s.name, error: s.error }));
    return { conversations, toolSteps, truncated: rows.length === MAX_CONVERSATIONS };
  }

  async metrics(tenantId: string, agentId: string, days: number) {
    const agent = await this.agentScoped(tenantId, agentId);
    const { conversations, toolSteps, truncated } = await this.load(tenantId, agentId, days);
    return { days, currentVersion: agent.version, truncated, versions: computeMetrics(conversations, toolSteps) };
  }

  /**
   * Re-diagnoses the current version. Findings are keyed by (version, fingerprint), so re-running refreshes them
   * instead of piling up duplicates; one a person dismissed stays dismissed while the problem persists; one whose
   * problem has gone away is dropped either way (if it returns, it comes back as a fresh, open finding).
   */
  async analyze(tenantId: string, agentId: string, days: number) {
    const agent = await this.agentScoped(tenantId, agentId);
    const { conversations, toolSteps } = await this.load(tenantId, agentId, days);
    const found = detectInsights({ version: agent.version, requiredFields: RequiredFieldsSpec.parse(agent.requiredFields ?? []), conversations, toolSteps });

    for (const f of found) {
      const data = { kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence as unknown as Prisma.InputJsonValue };
      await this.prisma.client.insight.upsert({
        where: { agentId_agentVersion_fingerprint: { agentId, agentVersion: agent.version, fingerprint: f.fingerprint } },
        create: { tenantId, agentId, agentVersion: agent.version, fingerprint: f.fingerprint, ...data },
        update: data, // status is deliberately not touched
      });
    }
    await this.prisma.client.insight.deleteMany({
      where: { agentId, tenantId, agentVersion: agent.version, fingerprint: { notIn: found.map((f) => f.fingerprint) } },
    });
    return this.list(tenantId, agentId);
  }

  async list(tenantId: string, agentId: string) {
    const agent = await this.agentScoped(tenantId, agentId);
    const rows = await this.prisma.client.insight.findMany({
      where: { agentId, tenantId, agentVersion: agent.version },
      orderBy: [{ createdAt: "desc" }],
    });
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return rows.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  }

  async getInsight(tenantId: string, agentId: string, insightId: string) {
    const insight = await this.prisma.client.insight.findFirst({ where: { id: insightId, agentId, tenantId } });
    if (!insight) throw new NotFoundException("Insight not found");
    return insight;
  }

  async setStatus(tenantId: string, agentId: string, insightId: string, status: InsightStatus) {
    await this.getInsight(tenantId, agentId, insightId);
    return this.prisma.client.insight.update({ where: { id: insightId }, data: { status } });
  }

  /** The visitor/agent text of a few evidence conversations — what the proposer is shown, and what a replay is built from. */
  async evidenceTranscripts(tenantId: string, agentId: string, evidence: InsightEvidence, limit: number) {
    const rows = await this.prisma.client.conversation.findMany({
      where: { tenantId, agentId, id: { in: evidence.conversationIds.slice(0, limit) } },
      select: { id: true, transcriptText: true },
    });
    return rows.filter((r) => r.transcriptText).map((r) => ({ id: r.id, text: r.transcriptText! }));
  }
}
