import type { InsightEvidence, InsightKind, InsightSeverity, RequiredFieldsSpec } from "@envoy/types";

/** The slice of a Conversation row the harness reads. */
export interface ConversationRow {
  id: string;
  status: "in_progress" | "completed" | "abandoned";
  agentVersion: number | null;
  handoffReason: string | null;
  turnCount: number | null;
  capturedData: Record<string, unknown>;
  ruleViolationsBlocked: Array<{ ruleId?: string }>;
  hasTranscript: boolean;
}

export interface ToolStepRow {
  conversationId: string;
  agentVersion: number | null;
  name: string;
  error: string | null;
}

export interface VersionMetrics {
  version: number;
  /** Everything started on this version in the window. */
  conversations: number;
  /** Visitors who left without saying anything. Not a failure of the agent, so excluded from every rate. */
  bounces: number;
  /** Conversations where the visitor actually engaged (completed, or abandoned after at least one message). */
  engaged: number;
  completed: number;
  abandoned: number;
  handoffs: number;
  completionRate: number | null;
  avgTurnsToComplete: number | null;
  blockedViolations: number;
  toolCalls: number;
  toolErrors: number;
}

export interface DetectedInsight {
  kind: InsightKind;
  fingerprint: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  evidence: InsightEvidence;
}

/** Below this many engaged conversations a rate is noise, and the harness says nothing rather than guess. */
export const MIN_ENGAGED = 8;
const EXAMPLES = 5;

const isBounce = (c: ConversationRow) => c.status === "abandoned" && (c.turnCount ?? 0) === 0;
const isEngaged = (c: ConversationRow) => c.status === "completed" || (c.status === "abandoned" && (c.turnCount ?? 0) > 0);
const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

export function computeMetrics(conversations: ConversationRow[], toolSteps: ToolStepRow[]): VersionMetrics[] {
  const versions = [...new Set(conversations.map((c) => c.agentVersion).filter((v): v is number => v !== null))].sort((a, b) => a - b);
  return versions.map((version) => {
    const mine = conversations.filter((c) => c.agentVersion === version);
    const engaged = mine.filter(isEngaged);
    const completed = mine.filter((c) => c.status === "completed");
    const abandoned = engaged.filter((c) => c.status === "abandoned");
    const turns = completed.map((c) => c.turnCount).filter((n): n is number => n !== null);
    const steps = toolSteps.filter((s) => s.agentVersion === version);
    return {
      version,
      conversations: mine.length,
      bounces: mine.filter(isBounce).length,
      engaged: engaged.length,
      completed: completed.length,
      abandoned: abandoned.length,
      handoffs: mine.filter((c) => c.handoffReason !== null).length,
      completionRate: engaged.length ? round(completed.length / engaged.length) : null,
      avgTurnsToComplete: turns.length ? round(turns.reduce((a, b) => a + b, 0) / turns.length, 1) : null,
      blockedViolations: mine.reduce((n, c) => n + c.ruleViolationsBlocked.length, 0),
      toolCalls: steps.length,
      toolErrors: steps.filter((s) => s.error !== null).length,
    };
  });
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mostCommon = (xs: string[]) => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Names what is going wrong with the CURRENT version, from real conversations. Every finding carries its
 * evidence (counts and example conversations) so it can be checked, and nothing is reported below a minimum
 * sample size — a harness that cries wolf on three conversations teaches people to ignore it.
 */
export function detectInsights(params: {
  version: number;
  requiredFields: RequiredFieldsSpec;
  conversations: ConversationRow[];
  toolSteps: ToolStepRow[];
}): DetectedInsight[] {
  const { version, requiredFields } = params;
  const mine = params.conversations.filter((c) => c.agentVersion === version);
  const engaged = mine.filter(isEngaged);
  const abandoned = engaged.filter((c) => c.status === "abandoned");
  const metrics = computeMetrics(params.conversations, params.toolSteps);
  const current = metrics.find((m) => m.version === version);
  const out: DetectedInsight[] = [];
  const ids = (cs: ConversationRow[]) => cs.slice(0, EXAMPLES).map((c) => c.id);

  if (current && engaged.length >= MIN_ENGAGED && current.completionRate !== null) {
    if (current.completionRate < 0.4) {
      out.push({
        kind: "low_completion",
        fingerprint: "low_completion",
        severity: current.completionRate < 0.25 ? "critical" : "warning",
        title: `Only ${pct(current.completionRate)} of conversations finish`,
        detail: `Of ${engaged.length} visitors who engaged with this version, ${current.completed} completed and ${current.abandoned} left part-way.`,
        evidence: { count: current.abandoned, total: engaged.length, conversationIds: ids(abandoned), facts: { completionRate: current.completionRate } },
      });
    }

    const handoffRate = current.handoffs / engaged.length;
    if (handoffRate >= 0.3) {
      const handed = mine.filter((c) => c.handoffReason !== null);
      out.push({
        kind: "high_handoff",
        fingerprint: "high_handoff",
        severity: "warning",
        title: `${pct(handoffRate)} of conversations are handed to a human`,
        detail: `${current.handoffs} of ${engaged.length} engaged conversations ended in a handoff. The agent may be giving up on things it could handle.`,
        evidence: { count: current.handoffs, total: engaged.length, conversationIds: ids(handed), facts: { handoffRate: round(handoffRate) } },
      });
    }

    // A drop against the version before it points straight at the last change.
    const previous = [...metrics].reverse().find((m) => m.version < version && m.engaged >= MIN_ENGAGED && m.completionRate !== null);
    if (previous && previous.completionRate! - current.completionRate >= 0.15) {
      out.push({
        kind: "version_regression",
        fingerprint: "version_regression",
        severity: "critical",
        title: `Completion dropped from ${pct(previous.completionRate!)} to ${pct(current.completionRate)} since v${previous.version}`,
        detail: `Version ${previous.version} completed ${pct(previous.completionRate!)} of ${previous.engaged} engaged conversations; version ${version} completes ${pct(current.completionRate)} of ${engaged.length}. Consider restoring v${previous.version} from the version history.`,
        evidence: { count: current.abandoned, total: engaged.length, conversationIds: ids(abandoned), facts: { from: previous.version, to: version, previousRate: previous.completionRate!, currentRate: current.completionRate } },
      });
    }
  }

  // Where do people leave? The first required field still missing when they went is what the agent was asking for.
  const required = requiredFields.filter((f) => f.required);
  const droppedAt = abandoned
    .filter((c) => c.hasTranscript)
    .map((c) => ({ c, field: required.find((f) => !(f.key in c.capturedData)) }))
    .filter((x): x is { c: ConversationRow; field: (typeof required)[number] } => x.field !== undefined);
  if (engaged.length >= MIN_ENGAGED && droppedAt.length >= 3) {
    const topKey = mostCommon(droppedAt.map((x) => x.field.key))!;
    const hits = droppedAt.filter((x) => x.field.key === topKey);
    const share = hits.length / droppedAt.length;
    if (hits.length >= 3 && share >= 0.3) {
      const field = hits[0]!.field;
      out.push({
        kind: "abandon_at_field",
        fingerprint: `abandon_at_field:${topKey}`,
        severity: share >= 0.6 ? "critical" : "warning",
        title: `Visitors leave when asked for “${field.label}”`,
        detail: `${hits.length} of ${droppedAt.length} visitors who abandoned had given everything before “${field.label}” and left while it was being asked for (${pct(share)}). It may feel intrusive, unclear, or asked too early.`,
        evidence: { count: hits.length, total: droppedAt.length, conversationIds: ids(hits.map((h) => h.c)), facts: { field: topKey, label: field.label, share: round(share) } },
      });
    }
  }

  // Rules that keep firing: the model keeps trying to say something forbidden, which usually means the script invites it.
  if (engaged.length >= MIN_ENGAGED) {
    const byRule = new Map<string, ConversationRow[]>();
    for (const c of mine) {
      for (const ruleId of new Set(c.ruleViolationsBlocked.map((v) => v.ruleId).filter((r): r is string => !!r))) {
        byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), c]);
      }
    }
    for (const [ruleId, cs] of byRule) {
      if (cs.length >= 3 && cs.length / engaged.length >= 0.15) {
        out.push({
          kind: "rule_blocked",
          fingerprint: `rule_blocked:${ruleId}`,
          severity: cs.length / engaged.length >= 0.4 ? "warning" : "info",
          title: `Rule “${ruleId}” blocks replies in ${pct(cs.length / engaged.length)} of conversations`,
          detail: `The agent drafted a reply breaking this rule in ${cs.length} of ${engaged.length} conversations. The rule is working — visitors never saw those replies — but the script may be steering the agent towards them.`,
          evidence: { count: cs.length, total: engaged.length, conversationIds: ids(cs), facts: { ruleId } },
        });
      }
    }
  }

  // Tools that keep failing.
  const stepsNow = params.toolSteps.filter((s) => s.agentVersion === version);
  for (const tool of new Set(stepsNow.map((s) => s.name))) {
    const calls = stepsNow.filter((s) => s.name === tool);
    const failures = calls.filter((s) => s.error !== null);
    if (calls.length >= 5 && failures.length / calls.length >= 0.25) {
      const rate = failures.length / calls.length;
      out.push({
        kind: "tool_failing",
        fingerprint: `tool_failing:${tool}`,
        severity: rate >= 0.5 ? "critical" : "warning",
        title: `${tool} fails ${pct(rate)} of the time`,
        detail: `${failures.length} of ${calls.length} calls to ${tool} were refused or errored. Most common: “${mostCommon(failures.map((f) => f.error!))}”.`,
        evidence: {
          count: failures.length,
          total: calls.length,
          conversationIds: [...new Set(failures.map((f) => f.conversationId))].slice(0, EXAMPLES),
          facts: { tool, topError: mostCommon(failures.map((f) => f.error!)) ?? "" },
        },
      });
    }
  }

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
