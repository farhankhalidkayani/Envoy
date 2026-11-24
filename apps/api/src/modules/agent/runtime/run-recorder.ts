import { Logger } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import type { RunStepKind } from "@envoy/types";
import type { PrismaService } from "../../core/prisma/prisma.service.js";

export interface RecordedStep {
  kind: RunStepKind;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  latencyMs?: number;
}

const MAX_JSON_CHARS = 4000;

/** Keeps trace rows bounded: a runaway tool result must not bloat the table. */
function clip(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= MAX_JSON_CHARS) return value as Prisma.InputJsonValue;
  return { truncated: true, preview: json.slice(0, MAX_JSON_CHARS) };
}

/**
 * Buffers one visitor turn's steps and writes them in a single insert. Trace
 * writing is observability, not correctness: a failure here is logged and
 * swallowed so it can never break a live conversation.
 */
export class TurnRecorder {
  private readonly logger = new Logger(TurnRecorder.name);
  private readonly steps: RecordedStep[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: { conversationId: string; tenantId: string; turn: number; startSeq: number },
  ) {}

  record(step: RecordedStep) {
    this.steps.push(step);
  }

  /** Sequence number the next turn should start from. */
  get nextSeq(): number {
    return this.ids.startSeq + this.steps.length;
  }

  async flush(): Promise<void> {
    if (this.steps.length === 0) return;
    try {
      await this.prisma.client.agentRunStep.createMany({
        data: this.steps.map((s, i) => ({
          conversationId: this.ids.conversationId,
          tenantId: this.ids.tenantId,
          turn: this.ids.turn,
          seq: this.ids.startSeq + i,
          kind: s.kind,
          name: s.name,
          input: clip(s.input),
          output: clip(s.output),
          error: s.error?.slice(0, 500),
          latencyMs: s.latencyMs,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn(`failed to write run trace: ${(err as Error).message}`);
    }
  }
}
