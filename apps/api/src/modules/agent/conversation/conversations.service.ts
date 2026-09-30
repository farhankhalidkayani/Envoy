import { Injectable, NotFoundException } from "@nestjs/common";
import type { OutcomeType } from "@envoy/types";
import type { Prisma } from "@envoy/db";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { PipelineQueueService } from "../../pipeline/pipeline-queue.service.js";
import { CaptureRoutingService } from "../../routing/capture-routing.service.js";
import type { LlmMessage } from "../providers/llm/types.js";

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly routing: CaptureRoutingService,
  ) {}

  async start(agentId: string, tenantId: string) {
    return this.prisma.client.conversation.create({
      data: { agentId, tenantId, channel: "chat", status: "in_progress" },
    });
  }

  /** For the portal's conversation dashboard — see build plan §Frontend structure. */
  async findAllForTenant(tenantId: string, agentId?: string, opts: { cursor?: string; take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    const rows = await this.prisma.client.conversation.findMany({
      where: { tenantId, ...(agentId ? { agentId } : {}) },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { agent: { select: { name: true } } },
    });
    const nextCursor = rows.length > take ? rows[take - 1]!.id : undefined;
    return { rows: rows.slice(0, take), nextCursor };
  }

  /** Dashboard stat cards need whole-tenant counts, not just whatever page is loaded. */
  async getStats(tenantId: string, agentId?: string) {
    const where = { tenantId, ...(agentId ? { agentId } : {}) };
    const [total, completed] = await Promise.all([
      this.prisma.client.conversation.count({ where }),
      this.prisma.client.conversation.count({ where: { ...where, status: "completed" } }),
    ]);
    return { total, completed };
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

    await this.routing.route(conversation.tenantId, { conversationId: params.conversationId });

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
