import { describe, expect, it } from "vitest";
import { ApprovalParams, CreateApprovalInput, canonicalParams } from "./approvals.js";

describe("ApprovalParams", () => {
  it("accepts exactly the five things that need a person, each with its own shape", () => {
    for (const ok of [
      { kind: "publish_agent" },
      { kind: "restore_version", version: 3 },
      { kind: "approve_proposal", proposalId: "p1" },
      { kind: "set_hard_rules", hardRules: [{ id: "r", text: "Never promise refunds" }] },
      { kind: "enable_tools", tools: ["book_meeting"] },
    ]) expect(ApprovalParams.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
  });
  it("can't express anything else", () => {
    for (const bad of [{ kind: "delete_agent" }, { kind: "create_api_token" }, { kind: "restore_version" }, { kind: "restore_version", version: 0 }, { kind: "enable_tools", tools: [] }, { kind: "enable_tools", tools: ["capture_field"] }, { kind: "set_hard_rules", hardRules: [{ id: "", text: "x" }] }, {}]) {
      expect(ApprovalParams.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("only lets CRM and calendar tools be requested (everything else is already allowed)", () => {
    expect(ApprovalParams.safeParse({ kind: "enable_tools", tools: ["lookup_crm_contact", "check_calendar_availability", "book_meeting"] }).success).toBe(true);
    expect(ApprovalParams.safeParse({ kind: "enable_tools", tools: ["handoff_to_human"] }).success).toBe(false);
  });
});

describe("CreateApprovalInput", () => {
  it("needs an agent, and caps the requester's free text", () => {
    expect(CreateApprovalInput.safeParse({ agentId: "a", params: { kind: "publish_agent" } }).success).toBe(true);
    expect(CreateApprovalInput.safeParse({ params: { kind: "publish_agent" } }).success).toBe(false);
    expect(CreateApprovalInput.safeParse({ agentId: "a", params: { kind: "publish_agent" }, reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("canonicalParams", () => {
  it("is the same regardless of key order, and different for different requests", () => {
    const a = canonicalParams({ kind: "approve_proposal", proposalId: "p", acknowledgeUntested: true });
    const b = canonicalParams({ acknowledgeUntested: true, proposalId: "p", kind: "approve_proposal" } as never);
    expect(a).toBe(b);
    expect(canonicalParams({ kind: "restore_version", version: 2 })).not.toBe(canonicalParams({ kind: "restore_version", version: 3 }));
    expect(canonicalParams({ kind: "set_hard_rules", hardRules: [{ id: "a", text: "t", action: "block", severity: "high" }] })).toContain('"hardRules"');
  });
});
