import { Logger } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import type { GoalProgressMap, RunStepKind } from "@envoy/types";
import type { PrismaService } from "../../core/prisma/prisma.service.js";
import type { ConversationsService } from "../conversation/conversations.service.js";

export interface StepRow {
  turn: number;
  seq: number;
  kind: RunStepKind;
  name: string;
  input?: Prisma.InputJsonValue;
  output?: Prisma.InputJsonValue;
  error?: string;
  latencyMs?: number;
}

/**
 * Where a run's side effects go. A live conversation persists them to its own
 * rows; a simulation (playground, scenarios) keeps them in memory — so
 * testing an agent can never create a lead, a stored trace, or a violation
 * count on a real conversation.
 */
export interface RunSink {
  writeSteps(rows: StepRow[]): Promise<void>;
  appendViolations(violations: unknown[]): Promise<void>;
  setGoalProgress(progress: GoalProgressMap): Promise<void>;
}

export class DbRunSink implements RunSink {
  private readonly logger = new Logger(DbRunSink.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly ids: { conversationId: string; tenantId: string },
  ) {}

  /** Observability, not correctness: a failed trace write is logged and swallowed. */
  async writeSteps(rows: StepRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.prisma.client.agentRunStep.createMany({
        data: rows.map((r) => ({ ...r, conversationId: this.ids.conversationId, tenantId: this.ids.tenantId })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn(`failed to write run trace: ${(err as Error).message}`);
    }
  }

  appendViolations(violations: unknown[]): Promise<void> {
    return this.conversations.appendViolations(this.ids.conversationId, violations);
  }

  async setGoalProgress(progress: GoalProgressMap): Promise<void> {
    await this.prisma.client.conversation
      .update({ where: { id: this.ids.conversationId }, data: { goalProgress: progress } })
      .catch((err: Error) => this.logger.warn(`failed to persist goal progress: ${err.message}`));
  }
}

export class MemoryRunSink implements RunSink {
  steps: StepRow[] = [];
  violations: unknown[] = [];
  goalProgress: GoalProgressMap = {};

  async writeSteps(rows: StepRow[]) {
    this.steps.push(...rows);
  }
  async appendViolations(violations: unknown[]) {
    this.violations.push(...violations);
  }
  async setGoalProgress(progress: GoalProgressMap) {
    this.goalProgress = progress;
  }
}
