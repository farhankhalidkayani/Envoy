import { describe, expect, it } from "vitest";
import { AgentSpec } from "./agent-spec.js";
import { InvalidProposalError, ProposalChanges, applyChanges, preservesHardRules, type AgentConfigParts } from "./improvement.js";

const base = (): AgentConfigParts => ({
  script: "Help visitors book a demo.",
  requiredFields: [
    { key: "email", label: "Email", type: "email", required: true },
    { key: "phone", label: "Phone", type: "phone", required: false },
  ],
  hardRules: [{ id: "no-refunds", text: "Never promise refunds", action: "block", severity: "high" }],
  spec: AgentSpec.parse({}),
});

describe("ProposalChanges", () => {
  it("must change something", () => {
    expect(ProposalChanges.safeParse({}).success).toBe(false);
    expect(ProposalChanges.safeParse({ script: "x" }).success).toBe(true);
  });
  it("cannot express removing or editing a rule, or changing fields, tools or limits", () => {
    // Unknown keys are stripped, so these collapse to "changes nothing" and are rejected.
    expect(ProposalChanges.safeParse({ removeHardRules: ["no-refunds"] }).success).toBe(false);
    expect(ProposalChanges.safeParse({ spec: { tools: [] } }).success).toBe(false);
    expect(ProposalChanges.safeParse({ requiredFields: [] }).success).toBe(false);
  });
  it("validates added rules", () => {
    expect(ProposalChanges.safeParse({ addHardRules: [{ id: "", text: "x" }] }).success).toBe(false);
    expect(ProposalChanges.parse({ addHardRules: [{ id: "r", text: "Never x" }] }).addHardRules![0]).toMatchObject({ action: "block", severity: "high" });
  });
});

describe("applyChanges", () => {
  it("replaces the script and persona, leaving everything else alone", () => {
    const out = applyChanges(base(), { script: "New script", persona: "Warm." });
    expect(out.script).toBe("New script");
    expect(out.spec.persona).toBe("Warm.");
    expect(out.requiredFields).toEqual(base().requiredFields);
    expect(out.hardRules).toEqual(base().hardRules);
    expect(out.spec.runtime).toEqual(base().spec.runtime);
  });

  it("sets hints on named fields only", () => {
    const out = applyChanges(base(), { fieldPrompts: { phone: "Explain it's only for the confirmation text." } });
    expect(out.requiredFields.find((f) => f.key === "phone")!.prompt).toContain("confirmation");
    expect(out.requiredFields.find((f) => f.key === "email")!.prompt).toBeUndefined();
  });

  it("rejects a hint for a field that doesn't exist", () => {
    expect(() => applyChanges(base(), { fieldPrompts: { ssn: "x" } })).toThrow(InvalidProposalError);
  });

  it("appends new hard rules after the existing ones, which are untouched", () => {
    const out = applyChanges(base(), { addHardRules: [{ id: "no-prices", text: "Never quote prices", action: "block", severity: "high" }] });
    expect(out.hardRules.map((r) => r.id)).toEqual(["no-refunds", "no-prices"]);
    expect(preservesHardRules(base().hardRules, out.hardRules)).toBe(true);
  });

  it("refuses a new rule that reuses an existing id (that would be an edit)", () => {
    expect(() => applyChanges(base(), { addHardRules: [{ id: "no-refunds", text: "Refunds are fine", action: "escalate", severity: "low" }] })).toThrow(/already exists/);
    expect(() => applyChanges(base(), { addHardRules: [{ id: "a", text: "x", action: "block", severity: "high" }, { id: "a", text: "y", action: "block", severity: "high" }] })).toThrow(InvalidProposalError);
  });

  it("does not mutate its input", () => {
    const config = base();
    const snapshot = JSON.stringify(config);
    applyChanges(config, { script: "x", persona: "y", fieldPrompts: { email: "z" }, addHardRules: [{ id: "n", text: "t", action: "block", severity: "high" }] });
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});

describe("preservesHardRules", () => {
  const rules = base().hardRules;
  it("accepts identical and extended sets", () => {
    expect(preservesHardRules(rules, rules)).toBe(true);
    expect(preservesHardRules(rules, [...rules, { id: "n", text: "t", action: "block", severity: "high" }])).toBe(true);
  });
  it("rejects a removed, reworded, softened or downgraded rule", () => {
    expect(preservesHardRules(rules, [])).toBe(false);
    expect(preservesHardRules(rules, [{ ...rules[0]!, text: "Refunds are fine" }])).toBe(false);
    expect(preservesHardRules(rules, [{ ...rules[0]!, action: "escalate" }])).toBe(false);
    expect(preservesHardRules(rules, [{ ...rules[0]!, severity: "low" }])).toBe(false);
  });
});
