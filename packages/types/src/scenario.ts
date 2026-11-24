import { z } from "zod";
import { BUILT_IN_TOOL_NAMES, GoalStatus } from "./agent-spec.js";
import { OutcomeType } from "./enums.js";

/**
 * A scenario is a scripted visitor plus what must be true afterwards. It is
 * the regression test for an agent: run it before publishing a change, or
 * against a different model, and see exactly which expectations broke.
 * Everything is deterministic data (no code) so tenants can author it in the
 * portal, and the same evaluator runs on the server and in previews.
 */

export const ScenarioExpectation = z.object({
  /** The conversation must (true) or must not (false) reach completion. */
  completes: z.boolean().optional(),
  outcomeType: OutcomeType.optional(),
  /** The visitor must end up handed to a human (true) or not (false). */
  handoff: z.boolean().optional(),
  /** Captured values that must match (compared as text, case-insensitively). */
  capturedEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Fields that must have been captured, whatever their value. */
  capturedKeys: z.array(z.string().min(1)).max(50).optional(),
  /** Tools that must have been called successfully at least once. */
  toolsCalled: z.array(z.enum(BUILT_IN_TOOL_NAMES)).max(20).optional(),
  toolsNotCalled: z.array(z.enum(BUILT_IN_TOOL_NAMES)).max(20).optional(),
  goalsAchieved: z.array(z.string().min(1)).max(20).optional(),
  /** Text that must appear in at least one agent reply (case-insensitive). */
  replyContains: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Text that must appear in NO agent reply — e.g. a forbidden promise. */
  replyNotContains: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** How many replies the hard-rule judge may have blocked (a blocked reply never reached the visitor). */
  minBlockedViolations: z.number().int().min(0).max(100).optional(),
  maxBlockedViolations: z.number().int().min(0).max(100).optional(),
  /** Must complete within this many visitor messages. */
  maxTurns: z.number().int().min(1).max(30).optional(),
});
export type ScenarioExpectation = z.infer<typeof ScenarioExpectation>;

/**
 * Stand-ins for the tenant's real systems during a simulation. Simulations
 * never touch the real CRM or calendar: lookups read `knownContacts`, and
 * bookings check against `busy` then succeed without creating anything.
 */
export const ScenarioSandbox = z.object({
  knownContacts: z.array(z.object({ email: z.string().email(), firstName: z.string().max(80).optional() })).max(20).default([]),
  busy: z.array(z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) })).max(50).default([]),
});
export type ScenarioSandbox = z.infer<typeof ScenarioSandbox>;

export const ScenarioDef = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  /** What the simulated visitor says, in order. Sent one at a time, each after the agent has replied. */
  turns: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  expect: ScenarioExpectation.default({}),
  sandbox: ScenarioSandbox.default({}),
});
export type ScenarioDef = z.infer<typeof ScenarioDef>;

/** What actually happened in a simulated conversation — the input to evaluation. */
export const ScenarioOutcome = z.object({
  replies: z.array(z.string()),
  /** Visitor messages actually sent (the run stops early once the conversation ends). */
  turnsUsed: z.number().int().min(0),
  completed: z.boolean(),
  outcomeType: OutcomeType.optional(),
  handoffReason: z.string().optional(),
  capturedData: z.record(z.string(), z.unknown()),
  toolCalls: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  goalProgress: z.record(z.string(), z.object({ status: GoalStatus })),
  blockedViolations: z.number().int().min(0),
});
export type ScenarioOutcome = z.infer<typeof ScenarioOutcome>;

export interface ScenarioCheck {
  name: string;
  passed: boolean;
  /** What was expected vs. what happened — shown to the tenant when a check fails. */
  detail: string;
}

const norm = (v: unknown) => String(v).trim().toLowerCase();

/** Pure: expectations + outcome → one check per stated expectation. A scenario passes iff every check does. */
export function evaluateScenario(expect: ScenarioExpectation, outcome: ScenarioOutcome): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const okTools = new Set(outcome.toolCalls.filter((t) => t.ok).map((t) => t.name));
  const text = outcome.replies.join("\n").toLowerCase();

  if (expect.completes !== undefined) {
    add(expect.completes ? "Conversation completes" : "Conversation does not complete", outcome.completed === expect.completes,
      outcome.completed ? "it completed" : "it did not complete");
  }
  if (expect.outcomeType) {
    add(`Outcome is ${expect.outcomeType}`, outcome.outcomeType === expect.outcomeType, `outcome was ${outcome.outcomeType ?? "none"}`);
  }
  if (expect.handoff !== undefined) {
    const handedOff = outcome.handoffReason !== undefined;
    add(expect.handoff ? "Hands off to a human" : "Does not hand off", handedOff === expect.handoff, handedOff ? `handed off: ${outcome.handoffReason}` : "no handoff");
  }
  for (const [key, want] of Object.entries(expect.capturedEquals ?? {})) {
    const got = outcome.capturedData[key];
    add(`Captured ${key} = ${String(want)}`, got !== undefined && norm(got) === norm(want), got === undefined ? "not captured" : `captured ${JSON.stringify(got)}`);
  }
  for (const key of expect.capturedKeys ?? []) {
    add(`Captured ${key}`, key in outcome.capturedData, key in outcome.capturedData ? "captured" : "not captured");
  }
  for (const tool of expect.toolsCalled ?? []) {
    add(`Called ${tool}`, okTools.has(tool), okTools.has(tool) ? "called successfully" : "never called successfully");
  }
  for (const tool of expect.toolsNotCalled ?? []) {
    const called = outcome.toolCalls.some((t) => t.name === tool);
    add(`Did not call ${tool}`, !called, called ? "it was called" : "not called");
  }
  for (const goal of expect.goalsAchieved ?? []) {
    const status = outcome.goalProgress[goal]?.status;
    add(`Goal ${goal} achieved`, status === "achieved", `status was ${status ?? "never set"}`);
  }
  for (const phrase of expect.replyContains ?? []) {
    add(`A reply mentions “${phrase}”`, text.includes(phrase.toLowerCase()), text.includes(phrase.toLowerCase()) ? "found" : "no reply contained it");
  }
  for (const phrase of expect.replyNotContains ?? []) {
    add(`No reply mentions “${phrase}”`, !text.includes(phrase.toLowerCase()), text.includes(phrase.toLowerCase()) ? "a reply contained it" : "none did");
  }
  if (expect.minBlockedViolations !== undefined) {
    add(`At least ${expect.minBlockedViolations} reply blocked by rules`, outcome.blockedViolations >= expect.minBlockedViolations, `${outcome.blockedViolations} blocked`);
  }
  if (expect.maxBlockedViolations !== undefined) {
    add(`At most ${expect.maxBlockedViolations} reply blocked by rules`, outcome.blockedViolations <= expect.maxBlockedViolations, `${outcome.blockedViolations} blocked`);
  }
  if (expect.maxTurns !== undefined) {
    const ok = outcome.completed && outcome.turnsUsed <= expect.maxTurns;
    add(`Completes within ${expect.maxTurns} messages`, ok, outcome.completed ? `took ${outcome.turnsUsed}` : "never completed");
  }
  return checks;
}

export const scenarioPassed = (checks: ScenarioCheck[]): boolean => checks.every((c) => c.passed);

/** Fills an expectation from a conversation that went well, so "save as scenario" starts from what actually happened. */
export function expectationFromOutcome(outcome: ScenarioOutcome): ScenarioExpectation {
  const tools = [...new Set(outcome.toolCalls.filter((t) => t.ok).map((t) => t.name))].filter(
    (n): n is (typeof BUILT_IN_TOOL_NAMES)[number] => (BUILT_IN_TOOL_NAMES as readonly string[]).includes(n) && n !== "capture_field",
  );
  return {
    completes: outcome.completed,
    ...(outcome.outcomeType ? { outcomeType: outcome.outcomeType } : {}),
    ...(outcome.handoffReason ? { handoff: true } : {}),
    ...(Object.keys(outcome.capturedData).length ? { capturedKeys: Object.keys(outcome.capturedData) } : {}),
    ...(tools.length ? { toolsCalled: tools } : {}),
  };
}
