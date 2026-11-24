import type { Prisma } from "@envoy/db";
import type { RunStepKind } from "@envoy/types";
import type { RunSink } from "./run-sink.js";

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

/** Buffers one visitor turn's steps and hands them to the run's sink in one write. */
export class TurnRecorder {
  private readonly steps: RecordedStep[] = [];

  constructor(
    private readonly sink: RunSink,
    private readonly ids: { turn: number; startSeq: number },
  ) {}

  record(step: RecordedStep) {
    this.steps.push(step);
  }

  /** Sequence number the next turn should start from. */
  get nextSeq(): number {
    return this.ids.startSeq + this.steps.length;
  }

  async flush(): Promise<void> {
    await this.sink.writeSteps(
      this.steps.map((s, i) => ({
        turn: this.ids.turn,
        seq: this.ids.startSeq + i,
        kind: s.kind,
        name: s.name,
        input: clip(s.input),
        output: clip(s.output),
        error: s.error?.slice(0, 500),
        latencyMs: s.latencyMs,
      })),
    );
  }
}
