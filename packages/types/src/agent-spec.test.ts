import { describe, expect, it } from "vitest";
import { AgentSpec, DEFAULT_AGENT_SPEC } from "./agent-spec.js";

describe("AgentSpec", () => {
  it("defaults to the classic runtime so legacy agents are unaffected", () => {
    expect(DEFAULT_AGENT_SPEC.runtime.mode).toBe("classic");
    expect(DEFAULT_AGENT_SPEC.goals).toEqual([]);
    expect(AgentSpec.parse({}).runtime.maxSteps).toBe(6);
  });

  it("accepts goals and tool permissions", () => {
    const spec = AgentSpec.parse({
      persona: "warm and brief",
      goals: [{ id: "book", title: "Book a demo", successCriteria: "Visitor gave a date and email" }],
      tools: [{ name: "handoff_to_human", enabled: false }],
      runtime: { mode: "agentic", maxSteps: 4 },
    });
    expect(spec.goals[0]!.priority).toBe("primary");
    expect(spec.runtime.mode).toBe("agentic");
  });

  it("rejects duplicate goal ids and duplicate tools", () => {
    const goal = { id: "g", title: "t", successCriteria: "c" };
    expect(AgentSpec.safeParse({ goals: [goal, goal] }).success).toBe(false);
    expect(
      AgentSpec.safeParse({ tools: [{ name: "update_goal" }, { name: "update_goal" }] }).success,
    ).toBe(false);
  });

  it("refuses to disable a core tool", () => {
    expect(AgentSpec.safeParse({ tools: [{ name: "capture_field", enabled: false }] }).success).toBe(false);
    expect(AgentSpec.safeParse({ tools: [{ name: "end_conversation", enabled: false }] }).success).toBe(false);
  });

  it("rejects unknown tool names and out-of-range limits", () => {
    expect(AgentSpec.safeParse({ tools: [{ name: "rm_rf" }] }).success).toBe(false);
    expect(AgentSpec.safeParse({ runtime: { maxSteps: 100 } }).success).toBe(false);
    expect(AgentSpec.safeParse({ goals: [{ id: "Bad Id", title: "t", successCriteria: "c" }] }).success).toBe(false);
  });
});

describe("opt-in tools", () => {
  it("accepts the CRM and calendar tools and lists them as opt-in", async () => {
    const { OPT_IN_TOOL_NAMES } = await import("./agent-spec.js");
    expect(OPT_IN_TOOL_NAMES).toEqual(["lookup_crm_contact", "check_calendar_availability", "book_meeting"]);
    const spec = AgentSpec.parse({ tools: [{ name: "book_meeting", enabled: true, maxCallsPerConversation: 1 }] });
    expect(spec.tools[0]!.name).toBe("book_meeting");
  });
});
