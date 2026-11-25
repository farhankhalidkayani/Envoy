import { describe, expect, it } from "vitest";
import { WorkflowDef } from "@envoy/types";
import { addStep, emptyDraft, formatOffset, insertVariable, moveStep, newStep, parseSampleLead, removeStep, replaceStep, variableKeys } from "./workflow-editor";

describe("steps", () => {
  const steps = [newStep("send_email"), newStep("wait"), newStep("send_sms")];
  it("adds the right kind of step with sensible defaults", () => {
    expect(addStep([], "wait")).toEqual([{ type: "wait", amount: 1, unit: "days" }]);
    expect(newStep("send_email")).toMatchObject({ type: "send_email", to: "lead" });
    expect(newStep("send_sms")).toEqual({ type: "send_sms", body: "" });
  });
  it("moves a step up or down, and ignores moves off either end", () => {
    expect(moveStep(steps, 0, 1).map((s) => s.type)).toEqual(["wait", "send_email", "send_sms"]);
    expect(moveStep(steps, 2, -1).map((s) => s.type)).toEqual(["send_email", "send_sms", "wait"]);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 1)).toBe(steps);
  });
  it("removes and replaces without mutating", () => {
    expect(removeStep(steps, 1).map((s) => s.type)).toEqual(["send_email", "send_sms"]);
    expect(replaceStep(steps, 1, { type: "wait", amount: 3, unit: "hours" })[1]).toEqual({ type: "wait", amount: 3, unit: "hours" });
    expect(steps).toHaveLength(3);
    expect(steps[1]).toEqual({ type: "wait", amount: 1, unit: "days" });
  });
});

describe("emptyDraft", () => {
  it("is a starting point that only fails validation for what the person still has to write", () => {
    const issues = WorkflowDef.safeParse(emptyDraft()).error!.issues.map((i) => i.path.join("."));
    expect(issues.sort()).toEqual(["name", "steps.0.body", "steps.0.subject"].sort());
    const filled = { ...emptyDraft(), name: "Follow up", steps: [{ type: "send_email" as const, to: "lead" as const, subject: "Hi", body: "Thanks" }] };
    expect(WorkflowDef.safeParse(filled).success).toBe(true);
  });
});

describe("formatOffset", () => {
  it("reads naturally", () => {
    expect(formatOffset(0)).toBe("right away");
    expect(formatOffset(30 * 60_000)).toBe("after 30 minutes");
    expect(formatOffset(60_000)).toBe("after 1 minute");
    expect(formatOffset(2 * 3_600_000)).toBe("after 2 hours");
    expect(formatOffset(27 * 3_600_000)).toBe("after 1 day 3 hours");
    expect(formatOffset(3 * 86_400_000 + 5 * 60_000)).toBe("after 3 days 5 minutes");
  });
});

describe("parseSampleLead", () => {
  it("types values so conditions behave as they will for real leads", () => {
    expect(parseSampleLead("name = Ada Lovelace\nbudget=8000\nvip = true\nnote = a = b\nzip = 007.5x\n\nnoequals\n= nokey")).toEqual({ name: "Ada Lovelace", budget: 8000, vip: true, note: "a = b", zip: "007.5x" });
  });
  it("keeps phone-like and empty values as text", () => {
    expect(parseSampleLead("phone = +14155550100\nblank =")).toEqual({ phone: "+14155550100", blank: "" });
  });
});

describe("variables", () => {
  it("inserts a placeholder after existing text with a separating space", () => {
    expect(insertVariable("", "name")).toBe("{{name}}");
    expect(insertVariable("Hi", "name")).toBe("Hi {{name}}");
    expect(insertVariable("Hi ", "name")).toBe("Hi {{name}}");
  });
  it("always offers the outcome, without duplicates", () => {
    expect(variableKeys(["name", "email", "name"])).toEqual(["name", "email", "outcome"]);
    expect(variableKeys(["outcome"])).toEqual(["outcome"]);
  });
});

describe("step conditions", () => {
  it("toggles an “only if…” condition on and off a step", async () => {
    const { toggleStepCondition } = await import("./workflow-editor");
    const on = toggleStepCondition({ type: "send_sms", body: "Hi" });
    expect(on).toEqual({ type: "send_sms", body: "Hi", when: { match: "all", conditions: [{ field: "", op: "equals", value: "" }] } });
    expect(toggleStepCondition(on)).toEqual({ type: "send_sms", body: "Hi" });
  });

  it("an “end here” step starts with a condition and keeps it", async () => {
    const { newStep, toggleStepCondition } = await import("./workflow-editor");
    const exit = newStep("exit");
    expect(exit).toEqual({ type: "exit", when: { match: "all", conditions: [{ field: "", op: "equals", value: "" }] } });
    expect(toggleStepCondition(exit)).toBe(exit);
  });
});
