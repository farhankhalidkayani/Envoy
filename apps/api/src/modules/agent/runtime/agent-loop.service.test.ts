import { describe, expect, it } from "vitest";
import type { AgentSpec, RequiredFieldsSpec } from "@envoy/types";
import { MockLlmProvider } from "../providers/llm/mock.provider.js";
import type { LlmProvider, LlmToolRequest, LlmToolResult } from "../providers/llm/types.js";
import { RuleEnforcerService } from "../rules/rule-enforcer.service.js";
import { AgentLoopService } from "./agent-loop.service.js";
import { ToolRegistry } from "./tool-registry.js";

const fields: RequiredFieldsSpec = [
  { key: "email", label: "Email", type: "email", required: true },
  { key: "plan", label: "Plan", type: "select", required: true, options: ["starter", "pro"] },
];

/** In-memory stand-ins for Redis/Postgres — the loop only needs these few methods. */
function harness(llm: LlmProvider, specInput: Partial<AgentSpec["runtime"]> = {}, extra: Partial<AgentSpec> = {}) {
  const sessionState = { history: [] as any[], capturedData: {} as Record<string, unknown> } as any;
  const steps: any[] = [];
  const violations: unknown[] = [];
  const sessions = {
    async appendMessages(_id: string, msgs: any[]) {
      sessionState.history.push(...msgs);
      return structuredClone(sessionState);
    },
    async patch(_id: string, partial: any) {
      Object.assign(sessionState, partial);
    },
  };
  const prisma = {
    client: {
      agentRunStep: { createMany: async ({ data }: any) => { steps.push(...data); } },
      conversation: { update: async () => ({}) },
    },
  };
  const extractor = {
    calls: 0,
    async extractAndMerge({ capturedDataSoFar }: any) {
      this.calls++;
      return { ...capturedDataSoFar, ...(extractor.result ?? {}) };
    },
    result: undefined as Record<string, unknown> | undefined,
  };
  const conversations = { appendViolations: async (_id: string, v: unknown[]) => { violations.push(...v); } };
  const loop = new AgentLoopService(
    llm,
    sessions as any,
    new ToolRegistry(),
    new RuleEnforcerService(llm),
    extractor as any,
    conversations as any,
    prisma as any,
    { getConnection: async () => null } as any,
    { hasCalendar: async () => false } as any,
  );
  const spec = { persona: "", goals: [], tools: [], runtime: { mode: "agentic", maxSteps: 6, maxToolCallsPerTurn: 8, toolTimeoutMs: 1000, extractionFallback: false, ...specInput }, ...extra };
  const turn = (userText: string, hardRules: any[] = []) =>
    loop.runTurn({
      conversationId: "c1",
      tenantId: "t1",
      userText,
      config: { script: "", requiredFields: fields, hardRules, spec: spec as AgentSpec },
    });
  return { turn, steps, violations, sessionState, extractor };
}

/** A scripted provider: returns the given results in order, then plain text forever. */
function scripted(results: LlmToolResult[], seen: LlmToolRequest[] = []): LlmProvider {
  const mock = new MockLlmProvider();
  let i = 0;
  return {
    name: "scripted",
    complete: mock.complete.bind(mock),
    judge: mock.judge.bind(mock),
    async completeWithTools(req) {
      seen.push(req);
      return results[i++] ?? { text: "ok", toolCalls: [] };
    },
  };
}
const call = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args });

describe("AgentLoopService", () => {
  it("runs tools, feeds results back, and returns the final reply", async () => {
    const seen: LlmToolRequest[] = [];
    const h = harness(
      scripted([{ text: "", toolCalls: [call("capture_field", { key: "email", value: "a@b.co" })] }, { text: "Got it — which plan?", toolCalls: [] }], seen),
    );
    const result = await h.turn("a@b.co");
    expect(result.visibleText).toBe("Got it — which plan?");
    expect(result.capturedData).toEqual({ email: "a@b.co" });
    expect(result.isComplete).toBe(false);
    // The second model call saw the tool result.
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolName: "capture_field" });
    expect(JSON.parse(seen[1]!.messages.at(-1)!.content)).toMatchObject({ ok: true });
    // Trace: model, tool, model.
    expect(h.steps.map((s) => `${s.kind}:${s.name}`)).toEqual(["model:scripted", "tool:capture_field", "model:scripted"]);
    expect(h.steps.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it("stops at maxSteps and still gives the visitor a reply", async () => {
    const forever: LlmProvider = {
      ...scripted([]),
      async completeWithTools() {
        return { text: "", toolCalls: [call("capture_field", { key: "email", value: "x" })] };
      },
    };
    const h = harness(forever, { maxSteps: 3 });
    const result = await h.turn("hello");
    expect(result.visibleText.length).toBeGreaterThan(0);
    expect(h.steps.filter((s) => s.kind === "model")).toHaveLength(3);
    expect(h.steps.some((s) => s.kind === "limit" && s.name === "max_steps")).toBe(true);
  });

  it("enforces the per-turn tool budget and tells the model so", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => call("capture_field", { key: "email", value: `a${i}@b.co` }, `c${i}`));
    const h = harness(scripted([{ text: "", toolCalls: calls }, { text: "done", toolCalls: [] }]), { maxToolCallsPerTurn: 2 });
    await h.turn("hi");
    const tools = h.steps.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(5);
    expect(tools.filter((s) => s.error?.includes("budget"))).toHaveLength(3);
    expect(h.steps.some((s) => s.name === "max_tool_calls_per_turn")).toBe(true);
  });

  it("degrades to a safe reply when the model call throws, and keeps the conversation alive", async () => {
    const broken: LlmProvider = {
      ...scripted([]),
      async completeWithTools() {
        throw new Error("provider down");
      },
    };
    const h = harness(broken);
    const result = await h.turn("hello");
    expect(result.visibleText).toContain("trouble");
    expect(h.steps[0]).toMatchObject({ kind: "model", error: "provider down" });
  });

  it("offers no tools after the conversation ends, so the model can only write a closing line", async () => {
    const seen: LlmToolRequest[] = [];
    const h = harness(
      scripted(
        [
          { text: "", toolCalls: [call("capture_field", { key: "email", value: "a@b.co" }, "1"), call("capture_field", { key: "plan", value: "pro" }, "2")] },
          { text: "", toolCalls: [call("end_conversation", { outcomeType: "demo_booking" })] },
          { text: "Thanks, bye!", toolCalls: [] },
        ],
        seen,
      ),
    );
    const result = await h.turn("a@b.co on pro");
    expect(result).toMatchObject({ isComplete: true, outcomeType: "demo_booking", visibleText: "Thanks, bye!" });
    expect(seen[0]!.tools.length).toBeGreaterThan(0);
    expect(seen[2]!.tools).toEqual([]);
  });

  it("does not let the model end the conversation early", async () => {
    const h = harness(
      scripted([{ text: "", toolCalls: [call("end_conversation", { outcomeType: "order" })] }, { text: "What's your email?", toolCalls: [] }]),
    );
    const result = await h.turn("bye");
    expect(result.isComplete).toBe(false);
    expect(h.steps.find((s) => s.name === "end_conversation")?.error).toContain("still missing");
  });

  it("reports a handoff with its reason", async () => {
    const h = harness(
      scripted([{ text: "", toolCalls: [call("handoff_to_human", { reason: "wants a person" })] }, { text: "A colleague will follow up.", toolCalls: [] }]),
    );
    const result = await h.turn("get me a human");
    expect(result).toMatchObject({ isComplete: true, handoffReason: "wants a person", outcomeType: undefined });
  });

  it("judges the final reply against hard rules before it reaches the visitor", async () => {
    const h = harness(new MockLlmProvider());
    const rules = [{ id: "no-refunds", text: "Never promise guaranteed refunds", action: "block", severity: "high" }];
    const result = await h.turn("can I get a refund?", rules);
    expect(result.visibleText).not.toContain("guaranteed refunds");
    expect(h.violations).toHaveLength(1);
    expect(h.steps.some((s) => s.kind === "judge")).toBe(true);
  });

  it("runs the extraction fallback when enabled, so a model that never calls tools still captures data", async () => {
    const lazy = scripted([{ text: "Sure!", toolCalls: [] }]);
    const h = harness(lazy, { extractionFallback: true });
    h.extractor.result = { email: "a@b.co" };
    const result = await h.turn("my email is a@b.co");
    expect(result.capturedData).toEqual({ email: "a@b.co" });
    expect(h.steps.some((s) => s.kind === "extract")).toBe(true);
  });

  it("persists tool messages in history but the visitor-facing text stays clean", async () => {
    const h = harness(scripted([{ text: "", toolCalls: [call("capture_field", { key: "email", value: "a@b.co" })] }, { text: "Thanks!", toolCalls: [] }]));
    await h.turn("a@b.co");
    expect(h.sessionState.history.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(h.sessionState.turn).toBe(1);
  });
});
