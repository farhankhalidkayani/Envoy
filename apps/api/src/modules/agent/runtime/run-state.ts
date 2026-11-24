import type { GoalProgressMap, OutcomeType } from "@envoy/types";

/** How a conversation was ended by a tool. */
export type TerminalState =
  | { kind: "end"; outcomeType: OutcomeType }
  | { kind: "handoff"; reason: string };

/**
 * Mutable state of one agent run, shared by the loop and the tools it
 * executes. Loaded from the session store at the start of a visitor turn and
 * written back at its end — tools mutate this object, never Redis/Postgres
 * directly, so a turn that fails midway leaves persisted state untouched.
 */
export class RunState {
  terminal?: TerminalState;
  /** Tool executions this turn (the per-turn budget). */
  toolCallsThisTurn = 0;

  constructor(
    public capturedData: Record<string, unknown>,
    public goalProgress: GoalProgressMap,
    /** Tool executions across the whole conversation, by tool name (for maxCallsPerConversation). */
    public toolCallCounts: Record<string, number>,
  ) {}
}
