import { describe, expect, it } from "vitest";
import type { RequiredFieldsSpec } from "@envoy/types";
import { MIN_ENGAGED, computeMetrics, detectInsights, type ConversationRow, type ToolStepRow } from "./analysis.js";

const fields: RequiredFieldsSpec = [
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone", required: true },
  { key: "note", label: "Note", type: "text", required: false },
];

let n = 0;
const conv = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: `c${++n}`, status: "completed", agentVersion: 2, handoffReason: null, turnCount: 4,
  capturedData: { email: "a@b.co", phone: "123456" }, ruleViolationsBlocked: [], hasTranscript: true, ...over,
});
const many = (k: number, over: Partial<ConversationRow> = {}) => Array.from({ length: k }, () => conv(over));
const abandonedAtPhone = (k: number) => many(k, { status: "abandoned", capturedData: { email: "a@b.co" }, turnCount: 3 });
const detect = (conversations: ConversationRow[], toolSteps: ToolStepRow[] = [], version = 2) =>
  detectInsights({ version, requiredFields: fields, conversations, toolSteps });
const kinds = (xs: ReturnType<typeof detect>) => xs.map((i) => i.fingerprint);

describe("computeMetrics", () => {
  it("separates bounces from engaged visitors and computes rates per version", () => {
    const m = computeMetrics(
      [
        ...many(6, { turnCount: 4 }), // completed
        ...many(2, { status: "abandoned", turnCount: 2 }), // engaged, left
        ...many(3, { status: "abandoned", turnCount: 0 }), // bounced
        conv({ handoffReason: "wants a person" }),
        ...many(2, { agentVersion: 1 }),
      ],
      [],
    );
    expect(m.map((x) => x.version)).toEqual([1, 2]);
    expect(m[1]).toMatchObject({ conversations: 12, bounces: 3, engaged: 9, completed: 7, abandoned: 2, handoffs: 1, completionRate: 0.778, avgTurnsToComplete: 4 });
    expect(m[0]).toMatchObject({ conversations: 2, completionRate: 1 });
  });

  it("counts blocked violations and tool errors, and has no rate without engaged visitors", () => {
    const m = computeMetrics(
      [conv({ ruleViolationsBlocked: [{ ruleId: "a" }, { ruleId: "b" }] }), ...many(2, { status: "abandoned", turnCount: 0 }).map((c) => ({ ...c, agentVersion: 3 }))],
      [{ conversationId: "x", agentVersion: 2, name: "book_meeting", error: null }, { conversationId: "x", agentVersion: 2, name: "book_meeting", error: "busy" }],
    );
    expect(m[0]).toMatchObject({ blockedViolations: 2, toolCalls: 2, toolErrors: 1 });
    expect(m[1]).toMatchObject({ engaged: 0, completionRate: null });
  });
});

describe("detectInsights: stays quiet on thin data", () => {
  it("reports nothing for a small or healthy sample", () => {
    expect(detect(many(MIN_ENGAGED - 1, { status: "abandoned", turnCount: 2 }))).toEqual([]);
    expect(detect(many(20))).toEqual([]);
  });
  it("won't name a drop-off point from a handful of abandonments", () => {
    expect(detect(abandonedAtPhone(4))).toEqual([]);
    expect(detect([...many(3), ...abandonedAtPhone(4)])).toEqual([]); // 7 engaged: still under the minimum
    expect(kinds(detect([...many(2), ...abandonedAtPhone(6)]))).toContain("abandon_at_field:phone");
  });
  it("ignores conversations from other versions", () => {
    expect(detect(many(20, { status: "abandoned", turnCount: 2, agentVersion: 1 }))).toEqual([]);
  });
});

describe("low completion / handoff / regression", () => {
  it("flags a low completion rate, critical when very low", () => {
    const mild = detect([...many(3), ...many(5, { status: "abandoned", turnCount: 2 })]).find((i) => i.kind === "low_completion")!;
    expect(mild).toMatchObject({ severity: "warning", evidence: { count: 5, total: 8 } });
    const bad = detect([...many(1), ...many(9, { status: "abandoned", turnCount: 2 })]).find((i) => i.kind === "low_completion")!;
    expect(bad.severity).toBe("critical");
    expect(bad.evidence.conversationIds.length).toBeLessThanOrEqual(5);
  });

  it("flags a high handoff rate", () => {
    const found = detect([...many(5), ...many(5, { handoffReason: "angry" })]).find((i) => i.kind === "high_handoff")!;
    expect(found.title).toContain("50%");
    expect(found.evidence).toMatchObject({ count: 5, total: 10 });
  });

  it("flags a regression against the previous version, and points at restoring it", () => {
    const found = detect([...many(10, { agentVersion: 1 }), ...many(4, { agentVersion: 2 }), ...many(6, { agentVersion: 2, status: "abandoned", turnCount: 2 })]).find((i) => i.kind === "version_regression")!;
    expect(found).toMatchObject({ severity: "critical", evidence: { facts: { from: 1, to: 2, previousRate: 1, currentRate: 0.4 } } });
    expect(found.detail).toContain("restoring v1");
  });

  it("does not compare against a previous version with too little data", () => {
    expect(kinds(detect([...many(3, { agentVersion: 1 }), ...many(10, { agentVersion: 2 })]))).not.toContain("version_regression");
  });
});

describe("abandon_at_field", () => {
  it("names the field visitors leave at, with the share and examples", () => {
    const found = detect([...many(4), ...abandonedAtPhone(6)]).find((i) => i.kind === "abandon_at_field")!;
    expect(found.fingerprint).toBe("abandon_at_field:phone");
    expect(found.title).toBe("Visitors leave when asked for “Phone”");
    expect(found.evidence).toMatchObject({ count: 6, total: 6, facts: { field: "phone", share: 1 } });
    expect(found.severity).toBe("critical");
  });

  it("only counts required fields, and ignores abandoned conversations with no recorded transcript", () => {
    const optionalOnly = many(6, { status: "abandoned", turnCount: 2, capturedData: { email: "a@b.co", phone: "1" } }); // missing only the optional 'note'
    expect(kinds(detect([...many(4), ...optionalOnly]))).not.toContain("abandon_at_field:note");
    const old = abandonedAtPhone(6).map((c) => ({ ...c, hasTranscript: false }));
    expect(kinds(detect([...many(4), ...old]))).not.toContain("abandon_at_field:phone");
  });

  it("needs a real concentration: three, and at least 30% of known drop-offs", () => {
    const spread = [
      ...many(2, { status: "abandoned", turnCount: 2, capturedData: { email: "a@b.co" } }), // left at phone
      ...many(2, { status: "abandoned", turnCount: 2, capturedData: {} }), // left at email
      ...many(2, { status: "abandoned", turnCount: 2, capturedData: { phone: "1" } }), // left at email (phone given first)
    ];
    expect(kinds(detect([...many(4), ...spread])).filter((k) => k.startsWith("abandon_at_field"))).toEqual(["abandon_at_field:email"]);
    expect(kinds(detect([...many(8), ...abandonedAtPhone(2)]))).not.toContain("abandon_at_field:phone");
  });
});

describe("rule_blocked", () => {
  it("flags a rule that blocks replies in many conversations", () => {
    const blocked = many(4, { ruleViolationsBlocked: [{ ruleId: "no-prices" }, { ruleId: "no-prices" }] });
    const found = detect([...blocked, ...many(6)]).find((i) => i.fingerprint === "rule_blocked:no-prices")!;
    expect(found).toMatchObject({ severity: "warning", evidence: { count: 4, total: 10 } }); // counted per conversation, not per violation
  });
  it("ignores a rarely-firing rule", () => {
    expect(kinds(detect([...many(1, { ruleViolationsBlocked: [{ ruleId: "r" }] }), ...many(12)]))).not.toContain("rule_blocked:r");
  });
});

describe("tool_failing", () => {
  const steps = (calls: number, errors: number, name = "book_meeting"): ToolStepRow[] =>
    Array.from({ length: calls }, (_, i) => ({ conversationId: `t${i}`, agentVersion: 2, name, error: i < errors ? "That time is no longer available." : null }));

  it("flags a tool that fails often, quoting its most common error", () => {
    const found = detect(many(10), steps(8, 4)).find((i) => i.kind === "tool_failing")!;
    expect(found).toMatchObject({ fingerprint: "tool_failing:book_meeting", severity: "critical", evidence: { count: 4, total: 8, facts: { tool: "book_meeting" } } });
    expect(found.detail).toContain("no longer available");
  });
  it("needs at least five calls and a 25% failure rate", () => {
    expect(detect(many(10), steps(4, 4))).toEqual([]);
    expect(detect(many(10), steps(20, 3))).toEqual([]);
  });
});

it("orders the most severe first", () => {
  const out = detect([...many(1), ...abandonedAtPhone(9)], []);
  expect(out.map((i) => i.severity)).toEqual([...out.map((i) => i.severity)].sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a] - { critical: 0, warning: 1, info: 2 }[b])));
});
