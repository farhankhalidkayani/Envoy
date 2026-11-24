import { z } from "zod";
import type { AgentSpec } from "./agent-spec.js";
import { HardRuleDef, type HardRulesSpec } from "./hard-rules.js";
import type { RequiredFieldsSpec } from "./required-fields.js";

/**
 * The improvement harness: look at how an agent really performed, name what
 * is going wrong, propose a specific fix, prove it on the agent's scenarios
 * before anyone approves it. This file holds the contracts both sides share.
 */

export const INSIGHT_KINDS = [
  "abandon_at_field",
  "rule_blocked",
  "tool_failing",
  "low_completion",
  "high_handoff",
  "version_regression",
] as const;
export const InsightKind = z.enum(INSIGHT_KINDS);
export type InsightKind = z.infer<typeof InsightKind>;

export const InsightSeverity = z.enum(["info", "warning", "critical"]);
export type InsightSeverity = z.infer<typeof InsightSeverity>;

export const InsightStatus = z.enum(["open", "dismissed"]);
export type InsightStatus = z.infer<typeof InsightStatus>;

export interface InsightEvidence {
  /** How many conversations (or calls) showed the problem… */
  count: number;
  /** …out of how many were considered. */
  total: number;
  /** A few real examples, newest first, to look at and to replay. */
  conversationIds: string[];
  /** Kind-specific facts, e.g. { field: "phone" } or { tool: "book_meeting", topError: "…" }. */
  facts: Record<string, string | number>;
}

/**
 * What a proposal may change. Deliberately narrow: the agent's wording and
 * hints, and NEW hard rules. It cannot remove or edit a hard rule, change
 * fields, tools, goals or limits — those change what the agent is allowed to
 * do, which is a human decision, not something an AI should draft unreviewed.
 */
export const ProposalChanges = z
  .object({
    script: z.string().trim().min(1).max(10_000).optional(),
    persona: z.string().trim().max(2000).optional(),
    /** Field key → the hint injected into the agent's instructions for that field. */
    fieldPrompts: z.record(z.string().min(1), z.string().trim().min(1).max(500)).optional(),
    addHardRules: z.array(HardRuleDef).min(1).max(10).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: "A proposal must change something" });
export type ProposalChanges = z.infer<typeof ProposalChanges>;

export const ProposalStatus = z.enum(["pending", "tested", "approved", "rejected"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export interface AgentConfigParts {
  script: string;
  requiredFields: RequiredFieldsSpec;
  hardRules: HardRulesSpec;
  spec: AgentSpec;
}

export class InvalidProposalError extends Error {}

/** Pure: the configuration an approved proposal would produce. Throws InvalidProposalError rather than guessing. */
export function applyChanges(config: AgentConfigParts, changes: ProposalChanges): AgentConfigParts {
  const next: AgentConfigParts = {
    script: changes.script ?? config.script,
    requiredFields: config.requiredFields,
    hardRules: config.hardRules,
    spec: changes.persona !== undefined ? { ...config.spec, persona: changes.persona } : config.spec,
  };

  if (changes.fieldPrompts) {
    const keys = new Set(config.requiredFields.map((f) => f.key));
    for (const key of Object.keys(changes.fieldPrompts)) {
      if (!keys.has(key)) throw new InvalidProposalError(`Unknown field "${key}"`);
    }
    next.requiredFields = config.requiredFields.map((f) =>
      changes.fieldPrompts![f.key] !== undefined ? { ...f, prompt: changes.fieldPrompts![f.key] } : f,
    );
  }

  if (changes.addHardRules) {
    const existing = new Set(config.hardRules.map((r) => r.id));
    for (const rule of changes.addHardRules) {
      if (existing.has(rule.id)) throw new InvalidProposalError(`A hard rule with id "${rule.id}" already exists`);
      existing.add(rule.id);
    }
    // Existing rules are carried over untouched and first; a proposal can only ever add.
    next.hardRules = [...config.hardRules, ...changes.addHardRules];
  }
  return next;
}

/** Whether a configuration keeps every hard rule of `before` exactly as it was — the harness's non-negotiable invariant. */
export function preservesHardRules(before: HardRulesSpec, after: HardRulesSpec): boolean {
  return before.every((rule) => {
    const kept = after.find((r) => r.id === rule.id);
    return kept !== undefined && kept.text === rule.text && kept.action === rule.action && kept.severity === rule.severity;
  });
}
