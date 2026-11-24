import { describe, expect, it } from "vitest";
import { ScenarioDef, evaluateScenario, expectationFromOutcome, scenarioPassed, type ScenarioOutcome } from "./scenario.js";

const outcome = (over: Partial<ScenarioOutcome> = {}): ScenarioOutcome => ({
  replies: ["Hi! Could you share your email?", "Thanks, you're booked in."],
  turnsUsed: 3,
  completed: true,
  outcomeType: "demo_booking",
  capturedData: { email: "Ada@Example.com", plan: "pro" },
  toolCalls: [{ name: "capture_field", ok: true }, { name: "book_meeting", ok: true }, { name: "capture_field", ok: false }],
  goalProgress: { qualify: { status: "achieved" } },
  blockedViolations: 0,
  ...over,
});
const run = (expectation: Parameters<typeof evaluateScenario>[0], o = outcome()) => evaluateScenario(expectation, o);

describe("ScenarioDef", () => {
  it("needs a name and at least one visitor message, with sensible defaults", () => {
    const s = ScenarioDef.parse({ name: "Happy path", turns: ["hi"] });
    expect(s.expect).toEqual({});
    expect(s.sandbox).toEqual({ knownContacts: [], busy: [] });
    expect(ScenarioDef.safeParse({ name: "x", turns: [] }).success).toBe(false);
    expect(ScenarioDef.safeParse({ name: "", turns: ["hi"] }).success).toBe(false);
    expect(ScenarioDef.safeParse({ name: "x", turns: ["  "] }).success).toBe(false);
  });
  it("rejects unknown tool names in expectations", () => {
    expect(ScenarioDef.safeParse({ name: "x", turns: ["a"], expect: { toolsCalled: ["rm_rf"] } }).success).toBe(false);
  });
});

describe("evaluateScenario", () => {
  it("has no checks, so passes, when nothing is expected", () => {
    expect(run({})).toEqual([]);
    expect(scenarioPassed([])).toBe(true);
  });

  it("checks completion and outcome", () => {
    expect(scenarioPassed(run({ completes: true, outcomeType: "demo_booking" }))).toBe(true);
    expect(run({ completes: true }, outcome({ completed: false }))[0]).toMatchObject({ passed: false, detail: "it did not complete" });
    expect(run({ outcomeType: "order" })[0]).toMatchObject({ passed: false, detail: "outcome was demo_booking" });
    expect(scenarioPassed(run({ completes: false }, outcome({ completed: false })))).toBe(true);
  });

  it("compares captured values loosely (case/whitespace, number vs text)", () => {
    expect(scenarioPassed(run({ capturedEquals: { email: " ada@example.com " } }))).toBe(true);
    expect(scenarioPassed(run({ capturedEquals: { n: 42 } }, outcome({ capturedData: { n: "42" } })))).toBe(true);
    expect(run({ capturedEquals: { plan: "starter" } })[0]).toMatchObject({ passed: false, detail: 'captured "pro"' });
    expect(run({ capturedEquals: { phone: "1" } })[0]!.detail).toBe("not captured");
    expect(scenarioPassed(run({ capturedKeys: ["email", "plan"] }))).toBe(true);
    expect(scenarioPassed(run({ capturedKeys: ["phone"] }))).toBe(false);
  });

  it("only counts successful tool calls as 'called'", () => {
    expect(scenarioPassed(run({ toolsCalled: ["book_meeting"] }))).toBe(true);
    expect(scenarioPassed(run({ toolsCalled: ["handoff_to_human"] }))).toBe(false);
    expect(scenarioPassed(run({ toolsCalled: ["capture_field"] }, outcome({ toolCalls: [{ name: "capture_field", ok: false }] })))).toBe(false);
    // …but a failed attempt still counts as having called it for 'not called'.
    expect(scenarioPassed(run({ toolsNotCalled: ["capture_field"] }, outcome({ toolCalls: [{ name: "capture_field", ok: false }] })))).toBe(false);
    expect(scenarioPassed(run({ toolsNotCalled: ["handoff_to_human"] }))).toBe(true);
  });

  it("checks goals, handoff and reply text", () => {
    expect(scenarioPassed(run({ goalsAchieved: ["qualify"] }))).toBe(true);
    expect(run({ goalsAchieved: ["close"] })[0]!.detail).toBe("status was never set");
    expect(scenarioPassed(run({ handoff: false }))).toBe(true);
    expect(scenarioPassed(run({ handoff: true }, outcome({ handoffReason: "angry" })))).toBe(true);
    expect(scenarioPassed(run({ replyContains: ["BOOKED"] }))).toBe(true);
    expect(scenarioPassed(run({ replyContains: ["refund"] }))).toBe(false);
    expect(scenarioPassed(run({ replyNotContains: ["guaranteed"] }))).toBe(true);
    expect(scenarioPassed(run({ replyNotContains: ["booked"] }))).toBe(false);
  });

  it("checks blocked-violation bounds and turn limits", () => {
    expect(scenarioPassed(run({ maxBlockedViolations: 0 }))).toBe(true);
    expect(scenarioPassed(run({ minBlockedViolations: 1 }, outcome({ blockedViolations: 2 })))).toBe(true);
    expect(scenarioPassed(run({ maxBlockedViolations: 0 }, outcome({ blockedViolations: 1 })))).toBe(false);
    expect(scenarioPassed(run({ maxTurns: 3 }))).toBe(true);
    expect(scenarioPassed(run({ maxTurns: 2 }))).toBe(false);
    expect(scenarioPassed(run({ maxTurns: 5 }, outcome({ completed: false })))).toBe(false);
  });

  it("fails if any one check fails", () => {
    const checks = run({ completes: true, capturedKeys: ["email"], replyNotContains: ["booked"] });
    expect(checks).toHaveLength(3);
    expect(scenarioPassed(checks)).toBe(false);
    expect(checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(["No reply mentions “booked”"]);
  });
});

describe("expectationFromOutcome", () => {
  it("proposes an expectation a good run would satisfy", () => {
    const o = outcome();
    const expectation = expectationFromOutcome(o);
    expect(expectation).toEqual({
      completes: true,
      outcomeType: "demo_booking",
      capturedKeys: ["email", "plan"],
      toolsCalled: ["book_meeting"], // capture_field is implied by capturedKeys
    });
    expect(scenarioPassed(evaluateScenario(expectation, o))).toBe(true);
  });
  it("notes a handoff", () => {
    expect(expectationFromOutcome(outcome({ handoffReason: "x", outcomeType: undefined }))).toMatchObject({ handoff: true });
  });
});
