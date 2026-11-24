import { describe, expect, it } from "vitest";
import { AgentSpec } from "@envoy/types";
import { RunState } from "./run-state.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentTool } from "./tool.js";

const noServices = {} as import("./tool.js").ToolServices;
const fields = [
  { key: "email", label: "Email", type: "email" as const, required: true },
  { key: "age", label: "Age", type: "number" as const, required: false },
  { key: "plan", label: "Plan", type: "select" as const, required: true, options: ["starter", "pro"] },
];
const goals = [{ id: "qualify", title: "Qualify", successCriteria: "has email and plan", priority: "primary" as const }];

function setup(specInput: unknown = {}, withGoals = true) {
  const registry = new ToolRegistry();
  const spec = AgentSpec.parse(specInput);
  const base = { requiredFields: fields, goals: withGoals ? goals : [], connections: { crm: false, calendar: false } };
  const tools = registry.resolve(spec, base);
  const toolConfig = registry.toolConfig(tools, base);
  const state = new RunState({}, {}, {});
  const run = (name: string, args: Record<string, unknown>, timeoutMs = 1000, toolList: AgentTool[] = tools) =>
    registry.execute({ tools: toolList, call: { id: "c", name, arguments: args }, spec, toolConfig, state, services: noServices, timeoutMs });
  return { registry, spec, tools, toolConfig, state, run };
}

describe("ToolRegistry.resolve", () => {
  it("offers capture_field, end_conversation, handoff and (with goals) update_goal", () => {
    expect(setup().tools.map((t) => t.name).sort()).toEqual(
      ["capture_field", "end_conversation", "handoff_to_human", "update_goal"],
    );
  });

  it("omits update_goal when there are no goals and capture_field when there are no fields", () => {
    expect(setup({}, false).tools.map((t) => t.name)).not.toContain("update_goal");
    const registry = new ToolRegistry();
    const tools = registry.resolve(AgentSpec.parse({}), { requiredFields: [], goals: [], connections: { crm: false, calendar: false } });
    expect(tools.map((t) => t.name)).not.toContain("capture_field");
  });

  it("honours a disabled tool permission", () => {
    expect(setup({ tools: [{ name: "handoff_to_human", enabled: false }] }).tools.map((t) => t.name)).not.toContain(
      "handoff_to_human",
    );
  });

  it("every tool's JSON schema is a plain object schema providers accept", () => {
    for (const tool of setup().tools) {
      expect(tool.parameters.type).toBe("object");
      expect(JSON.stringify(tool.parameters)).not.toMatch(/additionalProperties|oneOf|anyOf/);
    }
  });
});

describe("capture_field", () => {
  it("validates and stores a value, reporting what is still missing", async () => {
    const t = setup();
    const out = await t.run("capture_field", { key: "email", value: "a@b.co" });
    expect(out.outcome).toEqual({ ok: true, data: { captured: "email", stillMissing: ["plan"] } });
    expect(t.state.capturedData.email).toBe("a@b.co");
  });

  it("rejects invalid values and unknown keys without storing anything", async () => {
    const t = setup();
    const bad = await t.run("capture_field", { key: "email", value: "not-an-email" });
    expect(bad.outcome.ok).toBe(false);
    const unknown = await t.run("capture_field", { key: "ssn", value: "1" });
    expect(unknown.outcome).toMatchObject({ ok: false });
    expect((unknown.outcome as { error: string }).error).toContain("email, age, plan");
    expect(t.state.capturedData).toEqual({});
  });

  it("coerces text from the model into the field's real type", async () => {
    const t = setup();
    await t.run("capture_field", { key: "age", value: "42" });
    expect(t.state.capturedData.age).toBe(42);
  });
});

describe("end_conversation (the harness decides, not the model)", () => {
  it("refuses while required fields are missing", async () => {
    const t = setup();
    const out = await t.run("end_conversation", { outcomeType: "order" });
    expect(out.outcome).toMatchObject({ ok: false });
    expect((out.outcome as { error: string }).error).toContain("email, plan");
    expect(t.state.terminal).toBeUndefined();
  });

  it("refuses while a primary goal is unresolved, then allows it once resolved", async () => {
    const t = setup();
    await t.run("capture_field", { key: "email", value: "a@b.co" });
    await t.run("capture_field", { key: "plan", value: "pro" });
    const early = await t.run("end_conversation", { outcomeType: "order" });
    expect((early.outcome as { error: string }).error).toContain("qualify");

    await t.run("update_goal", { goalId: "qualify", status: "achieved" });
    const done = await t.run("end_conversation", { outcomeType: "order" });
    expect(done.outcome.ok).toBe(true);
    expect(t.state.terminal).toEqual({ kind: "end", outcomeType: "order" });
  });

  it("does not demand goal updates when update_goal is disabled", async () => {
    const t = setup({ tools: [{ name: "update_goal", enabled: false }] });
    await t.run("capture_field", { key: "email", value: "a@b.co" });
    await t.run("capture_field", { key: "plan", value: "pro" });
    expect((await t.run("end_conversation", { outcomeType: "order" })).outcome.ok).toBe(true);
  });
});

describe("update_goal / handoff_to_human", () => {
  it("records goal progress and rejects unknown goals", async () => {
    const t = setup();
    expect((await t.run("update_goal", { goalId: "nope", status: "achieved" })).outcome.ok).toBe(false);
    await t.run("update_goal", { goalId: "qualify", status: "in_progress", note: "started" });
    expect(t.state.goalProgress.qualify).toMatchObject({ status: "in_progress", note: "started" });
  });

  it("sets the handoff terminal state", async () => {
    const t = setup();
    await t.run("handoff_to_human", { reason: "angry" });
    expect(t.state.terminal).toEqual({ kind: "handoff", reason: "angry" });
  });
});

describe("harness guarantees", () => {
  it("rejects calls to tools that are not offered", async () => {
    const t = setup({ tools: [{ name: "handoff_to_human", enabled: false }] });
    const out = await t.run("handoff_to_human", { reason: "x" });
    expect(out.outcome).toEqual({ ok: false, error: 'Tool "handoff_to_human" is not available.' });
    expect(t.state.terminal).toBeUndefined();
  });

  it("rejects invalid arguments with a readable message", async () => {
    const t = setup();
    const out = await t.run("update_goal", { goalId: "qualify", status: "banana" });
    expect(out.outcome).toMatchObject({ ok: false });
    expect((out.outcome as { error: string }).error).toContain("Invalid arguments");
  });

  it("enforces maxCallsPerConversation across calls", async () => {
    const t = setup({ tools: [{ name: "capture_field", maxCallsPerConversation: 2 }] });
    await t.run("capture_field", { key: "age", value: "1" });
    await t.run("capture_field", { key: "age", value: "2" });
    const third = await t.run("capture_field", { key: "age", value: "3" });
    expect(third.outcome).toMatchObject({ ok: false });
    expect(t.state.capturedData.age).toBe(2);
  });

  it("turns a throwing tool into a generic error and never leaks the message", async () => {
    const t = setup();
    const boom: AgentTool = { ...t.tools[0]!, execute: async () => { throw new Error("db password is hunter2"); } };
    const out = await t.run("capture_field", { key: "age", value: "1" }, 1000, [boom]);
    expect(out.outcome).toEqual({ ok: false, error: 'Tool "capture_field" failed.' });
  });

  it("times out a hanging tool", async () => {
    const t = setup();
    const hang: AgentTool = { ...t.tools[0]!, execute: () => new Promise(() => {}) };
    const out = await t.run("capture_field", { key: "age", value: "1" }, 50, [hang]);
    expect(out.outcome).toEqual({ ok: false, error: 'Tool "capture_field" timed out.' });
  });
});
