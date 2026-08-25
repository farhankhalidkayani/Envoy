import { Injectable, NotFoundException } from "@nestjs/common";
import type { OutcomeType } from "@envoy/types";
import type { Prisma } from "@envoy/db";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { PipelineQueueService } from "../../pipeline/pipeline-queue.service.js";
import { CrmQueueService } from "../../crm/crm-queue.service.js";
import { CrmService } from "../../crm/crm.service.js";
import type { LlmMessage } from "../providers/llm/types.js";

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly crmQueue: CrmQueueService,
    private readonly crm: CrmService,
  ) {}

  async start(agentId: string, tenantId: string) {
    return this.prisma.client.conversation.create({
      data: { agentId, tenantId, channel: "chat", status: "in_progress" },
    });
  }

  /** For the portal's conversation dashboard — see build plan §Frontend structure. */
  async findAllForTenant(tenantId: string, agentId?: string) {
    return this.prisma.client.conversation.findMany({
      where: { tenantId, ...(agentId ? { agentId } : {}) },
      orderBy: { createdAt: "desc" },
      include: { agent: { select: { name: true } } },
    });
  }

  async findOneForTenant(tenantId: string, id: string) {
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id, tenantId },
      include: { agent: { select: { name: true } } },
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    return conversation;
  }

  /**
   * Marks a conversation complete and hands the raw message history to the
   * async pipeline for transcript assembly + summarization — this call
   * itself never waits on an LLM summarization call (see build plan
   * "Recordings pipeline": completion must never block on a summary).
   */
  async complete(params: {
    conversationId: string;
    outcomeType?: OutcomeType;
    capturedData: Record<string, unknown>;
    history: LlmMessage[];
  }) {
    const conversation = await this.prisma.client.conversation.update({
      where: { id: params.conversationId },
      data: {
        status: "completed",
        outcomeType: params.outcomeType,
        capturedData: params.capturedData as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    await this.pipelineQueue.enqueueSummary({
      conversationId: params.conversationId,
      messages: params.history,
    });

    // Auto-push is gated purely on "does this tenant have an active CRM
    // connection" — not a per-user feature flag (that gates who can VIEW/
    // EDIT the CRM connection in the portal, a different concern from
    // whether completed conversations get pushed automatically).
    const crmConnection = await this.crm.getConnection(conversation.tenantId);
    if (crmConnection) {
      await this.crmQueue.enqueuePush({ conversationId: params.conversationId });
    }

    return conversation;
  }

  async abandon(conversationId: string) {
    // Only in-progress conversations can be abandoned — a completed one
    // finishing its pipeline job after the socket drops is not an abandon.
    await this.prisma.client.conversation.updateMany({
      where: { id: conversationId, status: "in_progress" },
      data: { status: "abandoned" },
    });
  }

  async appendViolations(conversationId: string, newViolations: unknown[]) {
    if (newViolations.length === 0) return;
    const conversation = await this.prisma.client.conversation.findUnique({
      where: { id: conversationId },
      select: { ruleViolationsBlocked: true },
    });
    const existing = Array.isArray(conversation?.ruleViolationsBlocked)
      ? conversation.ruleViolationsBlocked
      : [];
    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: { ruleViolationsBlocked: [...existing, ...newViolations] as Prisma.InputJsonValue },
    });
  }
}
