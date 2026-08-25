import { z } from "zod";

export const HardRuleAction = z.enum(["block", "escalate"]);
export type HardRuleAction = z.infer<typeof HardRuleAction>;

export const HardRuleSeverity = z.enum(["low", "medium", "high"]);
export type HardRuleSeverity = z.infer<typeof HardRuleSeverity>;

/**
 * One entry in Agent.hardRules. Injected verbatim into the agent's stable
 * system-prompt prefix, and checked again by the post-generation judge
 * before a candidate reply is sent — see the two-layer enforcement design.
 */
export const HardRuleDef = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  action: HardRuleAction.default("block"),
  severity: HardRuleSeverity.default("high"),
});
export type HardRuleDef = z.infer<typeof HardRuleDef>;

export const HardRulesSpec = z.array(HardRuleDef).max(50);
export type HardRulesSpec = z.infer<typeof HardRulesSpec>;

/** One row of Conversation.ruleViolationsBlocked — the audit trail. */
export const RuleViolation = z.object({
  ruleId: z.string(),
  action: HardRuleAction,
  candidateText: z.string(),
  timestamp: z.string().datetime(),
});
export type RuleViolation = z.infer<typeof RuleViolation>;

export const RuleViolationsLog = z.array(RuleViolation);
export type RuleViolationsLog = z.infer<typeof RuleViolationsLog>;
