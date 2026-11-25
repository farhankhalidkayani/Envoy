import { describe, expect, it } from "vitest";
import { renderReport, isSynthetic, type ReportMeta } from "./report.js";
import type { ArmResult, LoopResult, TrialResult } from "./runner.js";

const trial = (i: number, completed: boolean): TrialResult => ({ trial: i, personaId: `v${i}`, temperament: "open", completed, left: !completed, timedOut: false, errored: false, turns: 5, capturedFields: completed ? 3 : 1, requiredFields: 3, blockedViolations: 0, toolCalls: 0, toolErrors: 0, handoff: false, tokens: { calls: 0, inputTokens: 0, outputTokens: 0 }, latencyMs: 1, transcript: "", capturedData: {} });
const arm = (label: string, k: number, n = 100): ArmResult => ({
  label, n, completed: k, errored: 0, completionRate: k / n, completionCI: { low: Math.max(0, k / n - 0.1), high: Math.min(1, k / n + 0.1) }, meanTurnsToComplete: 5.2, turnsCI: { low: 4.9, high: 5.5 },
  meanCapturePct: k / n, captureCI: { low: 0.4, high: 0.9 }, blockedPerConversation: 0, toolErrorRate: null, meanTokens: 0, meanLatencyMs: 1, trials: Array.from({ length: n }, (_, i) => trial(i, i < k)),
});
const cmp = (from: string, to: string, diff: number, p: number, verdict: "improved" | "worse" | "no clear difference") => ({ from, to, completionDiff: diff, completionDiffCI: { low: diff - 0.1, high: diff + 0.1 }, p, improved: 30, worsened: 1, verdict, capturePctDiff: 0.2, captureDiffCI: { low: 0.1, high: 0.3 } });
const loop = (over: Partial<LoopResult> = {}): LoopResult => ({
  rounds: [
    { round: 0, version: 1, arm: arm("baseline", 55), findings: [{ kind: "abandon_at_field", fingerprint: "abandon_at_field:phone", severity: "critical", title: "Visitors leave when asked for “Phone”" }], adopted: { fingerprint: "abandon_at_field:phone", title: "Visitors leave when asked for “Phone”", rationale: "Explain why you need it.", changes: { fieldPrompts: { phone: "explain why" } }, guard: { baselineCompleted: 12, candidateCompleted: 12, n: 12 } }, config: { script: "", persona: "", fieldHints: {}, hardRuleIds: [] } },
    { round: 1, version: 2, arm: arm("round 1", 88), findings: [], config: { script: "", persona: "", fieldHints: { phone: "explain why" }, hardRuleIds: [] } },
  ],
  stopReason: "no_findings",
  cumulative: [cmp("baseline", "round 1", 0.33, 0.0000001, "improved")],
  stepwise: [cmp("baseline", "round 1", 0.33, 0.0000001, "improved")],
  ...over,
});
const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({ provider: "mock", visitor: "rule", seed: 7, trialsPerRound: 100, rounds: 3, guardTrials: 12, date: "2030-01-01", command: "pnpm experiment", ...over });

describe("renderReport", () => {
  const md = renderReport(loop(), meta());

  it("leads with the headline numbers, their intervals and the verdict", () => {
    expect(md).toContain("Completion went from **55%**");
    expect(md).toContain("to **88%**");
    expect(md).toContain("+33.0 pts");
    expect(md).toContain("p < 0.001");
    expect(md).toContain("**improved**");
  });

  it("tabulates every round and what was adopted after it", () => {
    expect(md).toContain("| baseline | 55/100 = **55%**");
    expect(md).toContain("| round 1 | 88/100 = **88%**");
    expect(md).toMatch(/\| baseline \|.*Visitors leave when asked for “Phone”/);
  });

  it("shows the change itself and its safety check, so a reader can judge it", () => {
    expect(md).toContain('"fieldPrompts"');
    expect(md).toContain("cooperative visitors completed 12/12 before and 12/12 after");
    expect(md).toContain("Explain why you need it.");
  });

  it("explains how to read the paired test, and why it stopped", () => {
    expect(md).toContain("same** visitors");
    expect(md).toContain("exact McNemar");
    expect(md).toContain("nothing the detectors consider wrong");
    expect(md).toContain("pnpm experiment");
  });

  it("is loud, up front, that a synthetic run proves the machinery and not real-world improvement", () => {
    expect(isSynthetic(meta())).toBe(true);
    const head = md.split("## Result")[0]!;
    expect(head).toContain("synthetic run");
    expect(head).toContain("not evidence that a real model improves with real people");
  });

  it("drops that banner only when both the model and the visitors are real", () => {
    expect(isSynthetic(meta({ provider: "groq", visitor: "llm" }))).toBe(false);
    expect(isSynthetic(meta({ provider: "groq", visitor: "rule" }))).toBe(true);
    expect(isSynthetic(meta({ provider: "mock", visitor: "llm" }))).toBe(true);
    expect(renderReport(loop(), meta({ provider: "groq", visitor: "llm" }))).not.toContain("synthetic run");
  });

  it("never calls a non-significant change an improvement", () => {
    const flat = renderReport(loop({ cumulative: [cmp("baseline", "round 1", 0.04, 0.4, "no clear difference")], stepwise: [cmp("baseline", "round 1", 0.04, 0.4, "no clear difference")] }), meta());
    expect(flat).toContain("**no clear difference**");
    expect(flat).not.toContain("**improved**");
  });

  it("reports a rejected change and what it failed", () => {
    const bad = loop();
    bad.rounds[0]!.adopted = undefined;
    bad.rounds[0]!.rejected = { fingerprint: "x", title: "Add rule", reason: "cooperative visitors completed 3/12 (was 12/12)" };
    bad.rounds.pop();
    const text = renderReport({ ...bad, stopReason: "guard_rejected", cumulative: [], stepwise: [] }, meta());
    expect(text).toContain("Rejected: *Add rule* — cooperative visitors completed 3/12 (was 12/12)");
    expect(text).toContain("No change was adopted");
    expect(text).toContain("failed the safety check");
  });

  it("flags model errors, and keeps table cells intact when text contains pipes", () => {
    const errs = loop();
    errs.rounds[1]!.arm.errored = 2;
    errs.rounds[0]!.adopted!.title = "A | B";
    const text = renderReport(errs, meta());
    expect(text).toContain("2 trials ended in a model error");
    expect(text).toContain("A \\| B");
  });
});
