import { describe, expect, it } from "vitest";
import { defToForm, emptyScenarioForm, formToDef } from "./scenario-form";

const ok = (form: ReturnType<typeof emptyScenarioForm>) => {
  const r = formToDef(form);
  if (!r.ok) throw new Error(r.error);
  return r.def;
};

describe("scenario form ⇄ definition", () => {
  it("turns visitor lines into turns and leaves unset expectations out entirely", () => {
    const def = ok({ ...emptyScenarioForm(), name: "Happy path", turns: "Hello\n\n  ada@example.com  \n" });
    expect(def.turns).toEqual(["Hello", "ada@example.com"]);
    expect(def.expect).toEqual({});
  });

  it("maps every control to its expectation", () => {
    const def = ok({
      ...emptyScenarioForm(),
      name: "Full",
      turns: "hi",
      completes: "yes",
      handoff: "no",
      outcomeType: "demo_booking",
      capturedKeys: "email, plan",
      capturedEquals: "plan = pro\nname=Ada Lovelace",
      replyContains: "booked\nthank you",
      replyNotContains: "guaranteed",
      toolRules: { book_meeting: "must", handoff_to_human: "never", capture_field: "any" },
      goalsAchieved: ["qualify"],
      minBlocked: "1",
      maxBlocked: "2",
      maxTurns: "5",
    });
    expect(def.expect).toEqual({
      completes: true, handoff: false, outcomeType: "demo_booking",
      capturedKeys: ["email", "plan"], capturedEquals: { plan: "pro", name: "Ada Lovelace" },
      replyContains: ["booked", "thank you"], replyNotContains: ["guaranteed"],
      toolsCalled: ["book_meeting"], toolsNotCalled: ["handoff_to_human"],
      goalsAchieved: ["qualify"], minBlockedViolations: 1, maxBlockedViolations: 2, maxTurns: 5,
    });
  });

  it("parses the sandbox", () => {
    const def = ok({
      ...emptyScenarioForm(), name: "s", turns: "hi",
      knownContacts: "ada@example.com, Ada\nbob@example.com",
      busy: "2030-01-01T10:00:00Z, 2030-01-01T11:00:00Z",
    });
    expect(def.sandbox.knownContacts).toEqual([{ email: "ada@example.com", firstName: "Ada" }, { email: "bob@example.com" }]);
    expect(def.sandbox.busy).toEqual([{ start: "2030-01-01T10:00:00Z", end: "2030-01-01T11:00:00Z" }]);
  });

  it("explains what is wrong instead of sending a bad scenario", () => {
    expect(formToDef({ ...emptyScenarioForm(), turns: "hi" })).toMatchObject({ ok: false });
    expect(formToDef({ ...emptyScenarioForm(), name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("turns") });
    expect(formToDef({ ...emptyScenarioForm(), name: "x", turns: "hi", knownContacts: "not-an-email" })).toMatchObject({ ok: false });
    expect(formToDef({ ...emptyScenarioForm(), name: "x", turns: "hi", maxTurns: "0" })).toMatchObject({ ok: false });
    expect(formToDef({ ...emptyScenarioForm(), name: "x", turns: "hi", busy: "yesterday, today" })).toMatchObject({ ok: false });
  });

  it("round-trips: editing a saved scenario and saving it unchanged yields the same definition", () => {
    const def = ok({
      ...emptyScenarioForm(), name: "Round trip", turns: "a\nb", completes: "no", outcomeType: "order",
      capturedEquals: "k = v", toolRules: { book_meeting: "must", update_goal: "never" }, goalsAchieved: ["g"],
      maxBlocked: "0", knownContacts: "a@b.co, A", busy: "2030-01-01T10:00:00Z, 2030-01-01T11:00:00Z",
    });
    expect(ok(defToForm(def))).toEqual(def);
  });
});
