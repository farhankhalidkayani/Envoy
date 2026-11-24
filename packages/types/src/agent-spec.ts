import { z } from "zod";

/**
 * The agentic half of an agent's configuration (Agent.spec). The classic
 * half — script, requiredFields, hardRules, widgetConfig — keeps its own
 * columns; this adds what makes an agent *agentic*: goals, tools, and the
 * limits the runtime loop enforces.
 *
 * `runtime.mode` defaults to "classic" (the original single-completion
 * turn), so every agent that existed before this field is unaffected.
 */

export const AgentRuntimeMode = z.enum(["classic", "agentic"]);
export type AgentRuntimeMode = z.infer<typeof AgentRuntimeMode>;

export const GoalPriority = z.enum(["primary", "secondary"]);
export type GoalPriority = z.infer<typeof GoalPriority>;

export const GoalStatus = z.enum(["pending", "in_progress", "achieved", "failed"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

/** What the agent is trying to achieve, with a plain-language success test the model judges against. */
export const GoalDef = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-zA-Z0-9_]*$/, "id must be a camelCase/snake_case identifier"),
  title: z.string().min(1).max(120),
  successCriteria: z.string().min(1).max(500),
  priority: GoalPriority.default("primary"),
});
export type GoalDef = z.infer<typeof GoalDef>;

/** Names of the tools the platform provides. Adding one means a new entry here AND in the runtime's tool registry. */
export const BUILT_IN_TOOL_NAMES = [
  "capture_field",
  "update_goal",
  "end_conversation",
  "handoff_to_human",
  "lookup_crm_contact",
  "check_calendar_availability",
  "book_meeting",
] as const;
export type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];

/** Tools an agent cannot run without; the loop always offers them. */
export const CORE_TOOL_NAMES: readonly BuiltInToolName[] = ["capture_field", "end_conversation"];

/**
 * Tools that reach into the tenant's own systems (CRM, calendar). They are
 * OFF unless the tenant explicitly enables them in the spec, and even then
 * are only offered while the matching connection exists — an agent never
 * touches your CRM or calendar by default.
 */
export const OPT_IN_TOOL_NAMES: readonly BuiltInToolName[] = [
  "lookup_crm_contact",
  "check_calendar_availability",
  "book_meeting",
];

/** Per-agent permission for one tool. A tool absent from `tools` uses its default: enabled for regular tools, disabled for OPT_IN_TOOL_NAMES. */
export const ToolPermission = z.object({
  name: z.enum(BUILT_IN_TOOL_NAMES),
  enabled: z.boolean().default(true),
  /** Hard cap on calls across one whole conversation. Unset = no cap beyond the per-turn limit. */
  maxCallsPerConversation: z.number().int().positive().max(200).optional(),
});
export type ToolPermission = z.infer<typeof ToolPermission>;

export const AgentRuntimeConfig = z.object({
  mode: AgentRuntimeMode.default("classic"),
  /** Max model calls in one visitor turn (each tool round-trip uses one). */
  maxSteps: z.number().int().min(1).max(12).default(6),
  /** Max tool executions in one visitor turn, across all steps. */
  maxToolCallsPerTurn: z.number().int().min(1).max(30).default(8),
  /** Per-tool execution timeout. */
  toolTimeoutMs: z.number().int().min(100).max(30_000).default(8_000),
  /**
   * After the loop, also run the cheap extraction pass as a safety net, so a
   * weaker model that forgets to call capture_field still has its data captured.
   */
  extractionFallback: z.boolean().default(true),
});
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfig>;

export const AgentSpec = z
  .object({
    /** Free-text persona/tone guidance appended to the system prompt, e.g. "warm, brief, no emojis". */
    persona: z.string().max(2000).default(""),
    goals: z.array(GoalDef).max(10).default([]),
    tools: z.array(ToolPermission).max(20).default([]),
    runtime: AgentRuntimeConfig.default({}),
  })
  .superRefine((spec, ctx) => {
    const seenGoals = new Set<string>();
    spec.goals.forEach((g, i) => {
      if (seenGoals.has(g.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate goal id "${g.id}"`, path: ["goals", i, "id"] });
      }
      seenGoals.add(g.id);
    });
    const seenTools = new Set<string>();
    spec.tools.forEach((t, i) => {
      if (seenTools.has(t.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate tool "${t.name}"`, path: ["tools", i, "name"] });
      }
      seenTools.add(t.name);
      if (!t.enabled && CORE_TOOL_NAMES.includes(t.name)) {
        ctx.addIssue({
          code: "custom",
          message: `"${t.name}" is a core tool and cannot be disabled`,
          path: ["tools", i, "enabled"],
        });
      }
    });
  });
export type AgentSpec = z.infer<typeof AgentSpec>;

export const DEFAULT_AGENT_SPEC: AgentSpec = AgentSpec.parse({});

/** Live progress of one goal within one conversation. */
export const GoalProgress = z.object({
  status: GoalStatus,
  note: z.string().max(500).optional(),
  updatedAt: z.string().datetime(),
});
export type GoalProgress = z.infer<typeof GoalProgress>;
export const GoalProgressMap = z.record(z.string(), GoalProgress);
export type GoalProgressMap = z.infer<typeof GoalProgressMap>;

/** One row of the run trace — what the loop did, step by step. */
export const RunStepKind = z.enum(["model", "tool", "judge", "extract", "limit"]);
export type RunStepKind = z.infer<typeof RunStepKind>;
