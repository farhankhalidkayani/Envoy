import type { z } from "zod";
import type { BuiltInToolName, GoalDef, RequiredFieldsSpec } from "@envoy/types";
import type { RunState } from "./run-state.js";

/** The slice of agent config a tool may read. */
export interface ToolConfig {
  requiredFields: RequiredFieldsSpec;
  goals: GoalDef[];
  /** Which tenant systems are connected, resolved once per turn. Tools that need one are simply not offered without it. */
  connections: { crm: boolean; calendar: boolean };
  /** Names of the tools offered to the model this run — lets a tool's own preconditions depend on its siblings. */
  offeredTools: ReadonlySet<string>;
}

/** The tenant's own systems, already bound to the tenant — tools never see (or choose) a tenantId. */
export interface ToolServices {
  lookupCrmContact(email: string): Promise<{ success: boolean; found?: boolean; firstName?: string; error?: string }>;
  getBusyIntervals(from: Date, to: Date): Promise<{ success: true; busy: Array<{ start: string; end: string }> } | { success: false; error: string }>;
  bookSlot(req: {
    start: Date;
    durationMinutes?: number;
    title?: string;
    attendeeEmail?: string;
  }): Promise<{ success: true; eventId: string; link?: string; start: string; end: string } | { success: false; error: string }>;
}

export interface ToolContext {
  config: ToolConfig;
  state: RunState;
  services: ToolServices;
}

export type ToolOutcome = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string };

/**
 * A capability the model can invoke. The model only ever sees `name`,
 * `description` and `parameters`; validation, permission checks, limits and
 * execution belong to the harness (ToolRegistry), never to the model.
 */
export interface AgentTool {
  name: BuiltInToolName;
  description: string;
  /** JSON Schema shown to the model. Keep it to the subset every provider accepts (no oneOf / type arrays / additionalProperties). */
  parameters: Record<string, unknown>;
  /** Cap on calls per conversation when the tenant hasn't set one. Side-effecting tools use a small default. */
  defaultMaxCallsPerConversation?: number;
  /** The authoritative validator — whatever the model sends is parsed with this before `execute` ever runs. */
  input: z.ZodTypeAny;
  /** Whether to offer this tool for the agent's current config. */
  isAvailable(config: ToolConfig): boolean;
  execute(args: any, ctx: ToolContext): Promise<ToolOutcome>;
}
