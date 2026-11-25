import { Injectable } from "@nestjs/common";
import { applyChanges, preservesHardRules, type AgentConfigParts, type InsightEvidence } from "@envoy/types";
import type { ModelContext } from "../../models/model-context.js";
import type { AgentPromptConfig } from "../prompt/system-prompt.builder.js";
import { ProposerService } from "../improvement/proposer.js";
import { detectInsights, type ConversationRow, type DetectedInsight } from "../improvement/analysis.js";
import { SimulationService, type SimAgent } from "../simulation/simulation.service.js";
import { bootstrapMeanCI, bootstrapPairedDiffCI, mcnemarExact, mean, newcombeDiff, verdict, wilson, type Interval, type Verdict } from "./stats.js";
import { DEFAULT_MIX, RuleVisitor, samplePersona, type PopulationMix, type Persona, type Visitor } from "./visitors.js";

/** The "workspace" experiments run under: a name for the daily meter and Redis keys, not a real tenant. */
export const EXPERIMENT_TENANT = "experiment";

export interface TrialResult {
  trial: number;
  personaId: string;
  temperament: Persona["temperament"];
  completed: boolean;
  /** The visitor chose to leave. */
  left: boolean;
  timedOut: boolean;
  /** A model/provider failure ended the trial; counted as not completed and reported separately. */
  errored: boolean;
  turns: number;
  capturedFields: number;
  requiredFields: number;
  blockedViolations: number;
  toolCalls: number;
  toolErrors: number;
  handoff: boolean;
  tokens: { calls: number; inputTokens: number; outputTokens: number };
  latencyMs: number;
  transcript: string;
  capturedData: Record<string, unknown>;
}

export interface ArmResult {
  label: string;
  n: number;
  completed: number;
  errored: number;
  completionRate: number;
  completionCI: Interval;
  /** Messages the visitor sent before the conversation finished, over completed conversations only. */
  meanTurnsToComplete: number | null;
  turnsCI: Interval | null;
  /** Share of the required fields captured, over ALL trials (a visitor who leaves early still gave some). */
  meanCapturePct: number;
  captureCI: Interval;
  blockedPerConversation: number;
  toolErrorRate: number | null;
  meanTokens: number;
  meanLatencyMs: number;
  trials: TrialResult[];
}

export interface Comparison {
  from: string;
  to: string;
  /** Completion-rate change, in percentage points of the whole population. */
  completionDiff: number;
  completionDiffCI: Interval;
  /** Exact McNemar test: the same visitors met both versions, so only the ones whose outcome flipped count. */
  p: number;
  improved: number;
  worsened: number;
  verdict: Verdict;
  capturePctDiff: number;
  captureDiffCI: Interval;
}

export interface ExperimentOptions {
  trials: number;
  seed: number;
  mix?: PopulationMix;
  maxTurns?: number;
  /** Trials in flight at once. Raise for slow (real-model) runs. */
  concurrency?: number;
  /** How a persona is played. Default: the deterministic rule-based visitor. */
  visitor?: (persona: Persona) => Visitor;
}

export interface LoopOptions extends ExperimentOptions {
  rounds: number;
  /** Cooperative visitors used to confirm a candidate change hasn't broken the basics before it is adopted. */
  guardTrials?: number;
}

export type StopReason = "max_rounds" | "no_findings" | "no_new_findings" | "proposal_failed" | "no_change" | "guard_rejected";

export interface RoundResult {
  round: number;
  version: number;
  arm: ArmResult;
  /** What was found in this round's conversations, and which finding the next change addressed. */
  findings: Array<Pick<DetectedInsight, "kind" | "fingerprint" | "severity" | "title">>;
  /** The change adopted at the END of this round, which the next round measures. */
  adopted?: { fingerprint: string; title: string; rationale: string; changes: unknown; guard: { baselineCompleted: number; candidateCompleted: number; n: number } };
  rejected?: { fingerprint: string; title: string; reason: string };
  config: { script: string; fieldHints: Record<string, string>; hardRuleIds: string[]; persona: string };
}

export interface LoopResult {
  rounds: RoundResult[];
  stopReason: StopReason;
  /** Each round against round 0, and against the round before it. */
  cumulative: Comparison[];
  stepwise: Comparison[];
}

const summarise = (c: AgentConfigParts): RoundResult["config"] => ({
  script: c.script,
  persona: c.spec.persona,
  fieldHints: Object.fromEntries(c.requiredFields.filter((f) => f.prompt).map((f) => [f.key, f.prompt!])),
  hardRuleIds: c.hardRules.map((r) => r.id),
});

/** Runs `tasks` with at most `limit` in flight, keeping results in order. */
async function pool<T>(count: number, limit: number, run: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
      while (next < count) {
        const i = next++;
        out[i] = await run(i);
      }
    }),
  );
  return out;
}

@Injectable()
export class ExperimentRunner {
  constructor(
    private readonly sim: SimulationService,
    private readonly proposer: ProposerService,
  ) {}

  private requiredCount(agent: SimAgent) {
    return agent.config.requiredFields.filter((f) => f.required).length;
  }

  /** One simulated visitor talking to the agent until it finishes, they leave, or patience (maxTurns) runs out. */
  async runTrial(agent: SimAgent, persona: Persona, trial: number, opts: Pick<ExperimentOptions, "maxTurns" | "visitor">): Promise<TrialResult> {
    const visitor = opts.visitor ? opts.visitor(persona) : new RuleVisitor(persona);
    const sessionId = `exp_${trial}_${Math.random().toString(36).slice(2, 8)}`;
    const modelContext: ModelContext = { tenantId: EXPERIMENT_TENANT, unrecorded: true };
    const lines: string[] = [];
    const started = Date.now();
    let turns = 0;
    let last: Awaited<ReturnType<SimulationService["turn"]>> | undefined;
    let left = false;
    let errored = false;
    let blocked = 0;
    let toolCalls = 0;
    let toolErrors = 0;

    try {
      let action = await visitor.next(null);
      const maxTurns = opts.maxTurns ?? 12;
      while (turns < maxTurns) {
        if (action.type === "leave") {
          left = true;
          break;
        }
        turns++;
        lines.push(`Visitor: ${action.message}`);
        last = await this.sim.turn({ tenantId: EXPERIMENT_TENANT, agent, sessionId, message: action.message, sandbox: { knownContacts: [], busy: [] }, modelContext, unmetered: true });
        lines.push(`Agent: ${last.reply}`);
        blocked += last.blockedViolations;
        for (const s of last.steps) if (s.kind === "tool") (toolCalls++, s.error && toolErrors++);
        if (last.isComplete) break;
        action = await visitor.next(last.reply);
      }
    } catch {
      errored = true;
    } finally {
      await this.sim.reset(EXPERIMENT_TENANT, sessionId).catch(() => {});
    }

    const completed = !errored && last?.isComplete === true;
    return {
      trial,
      personaId: persona.id,
      temperament: persona.temperament,
      completed,
      left,
      timedOut: !completed && !left && !errored,
      errored,
      turns,
      capturedFields: Object.keys(last?.capturedData ?? {}).length,
      requiredFields: this.requiredCount(agent),
      blockedViolations: blocked,
      toolCalls,
      toolErrors,
      handoff: last?.handoffReason !== undefined,
      tokens: modelContext.totals ?? { calls: 0, inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
      transcript: lines.join("\n"),
      capturedData: last?.capturedData ?? {},
    };
  }

  /** The same `trials` visitors (seeded) meet one version of the agent. Trial i is the same person in every arm. */
  async runArm(label: string, agent: SimAgent, opts: ExperimentOptions): Promise<ArmResult> {
    const trials = await pool(opts.trials, opts.concurrency ?? 1, (i) => this.runTrial(agent, samplePersona(opts.seed + i, opts.mix ?? DEFAULT_MIX), i, opts));
    return this.aggregate(label, trials, opts.seed);
  }

  aggregate(label: string, trials: TrialResult[], seed: number): ArmResult {
    const done = trials.filter((t) => t.completed);
    const capture = trials.map((t) => (t.requiredFields ? Math.min(1, t.capturedFields / t.requiredFields) : 1));
    const calls = trials.reduce((n, t) => n + t.toolCalls, 0);
    return {
      label,
      n: trials.length,
      completed: done.length,
      errored: trials.filter((t) => t.errored).length,
      completionRate: done.length / trials.length,
      completionCI: wilson(done.length, trials.length),
      meanTurnsToComplete: done.length ? mean(done.map((t) => t.turns)) : null,
      turnsCI: done.length ? bootstrapMeanCI(done.map((t) => t.turns), seed + 1) : null,
      meanCapturePct: mean(capture),
      captureCI: bootstrapMeanCI(capture, seed + 2),
      blockedPerConversation: mean(trials.map((t) => t.blockedViolations)),
      toolErrorRate: calls ? trials.reduce((n, t) => n + t.toolErrors, 0) / calls : null,
      meanTokens: mean(trials.map((t) => t.tokens.inputTokens + t.tokens.outputTokens)),
      meanLatencyMs: mean(trials.map((t) => t.latencyMs)),
      trials,
    };
  }

  /** Same visitors, two versions: did completion really change, or is it noise? */
  compare(before: ArmResult, after: ArmResult, seed = 1): Comparison {
    if (before.n !== after.n) throw new Error("Arms must have the same number of trials to be compared as pairs");
    let improved = 0;
    let worsened = 0;
    for (let i = 0; i < before.n; i++) {
      const b = before.trials[i]!.completed;
      const a = after.trials[i]!.completed;
      if (!b && a) improved++;
      if (b && !a) worsened++;
    }
    const diffCI = newcombeDiff(before.completed, before.n, after.completed, after.n);
    const p = mcnemarExact(improved, worsened);
    const capture = (arm: ArmResult) => arm.trials.map((t) => (t.requiredFields ? Math.min(1, t.capturedFields / t.requiredFields) : 1));
    return {
      from: before.label,
      to: after.label,
      completionDiff: after.completionRate - before.completionRate,
      completionDiffCI: diffCI,
      p,
      improved,
      worsened,
      verdict: verdict(diffCI, p),
      capturePctDiff: after.meanCapturePct - before.meanCapturePct,
      captureDiffCI: bootstrapPairedDiffCI(capture(before), capture(after), seed + 3),
    };
  }

  private toRows(arm: ArmResult, version: number): ConversationRow[] {
    return arm.trials.map((t) => ({
      id: `trial-${t.trial}`,
      status: t.completed ? ("completed" as const) : ("abandoned" as const),
      agentVersion: version,
      handoffReason: t.handoff ? "handoff" : null,
      turnCount: t.turns,
      capturedData: t.capturedData,
      ruleViolationsBlocked: Array.from({ length: t.blockedViolations }, () => ({})),
      hasTranscript: true,
    }));
  }

  /**
   * "Improves with every run", measured. Each round: measure the current agent on the same seeded visitors, diagnose
   * what is going wrong with the SAME detectors the product uses, have the proposer draft a fix, accept it only if
   * a cooperative cohort still completes and no hard rule changed (the product's regression guard), and measure again.
   * In the product a person approves each change; here the guard stands in for them, which is the one difference.
   */
  async runLoop(baseline: SimAgent, opts: LoopOptions): Promise<LoopResult> {
    const guardN = opts.guardTrials ?? 12;
    const guardOpts: ExperimentOptions = { ...opts, trials: guardN, seed: opts.seed + 1_000_000, mix: { open: 1, reluctant: 0, hardline: 0 } };
    const rounds: RoundResult[] = [];
    const tried = new Set<string>();
    let config: AgentConfigParts = { script: baseline.config.script, requiredFields: baseline.config.requiredFields, hardRules: baseline.config.hardRules, spec: baseline.config.spec! };
    let stopReason: StopReason = "max_rounds";

    for (let round = 0; round <= opts.rounds; round++) {
      const version = baseline.version + round;
      const agent = this.agentWith(baseline, config, version);
      const arm = await this.runArm(round === 0 ? "baseline" : `round ${round}`, agent, opts);
      const insights = detectInsights({ version, requiredFields: config.requiredFields, conversations: this.toRows(arm, version), toolSteps: [] });
      const result: RoundResult = { round, version, arm, findings: insights.map(({ kind, fingerprint, severity, title }) => ({ kind, fingerprint, severity, title })), config: summarise(config) };
      rounds.push(result);
      if (round === opts.rounds) break;

      const target = insights.find((i) => !tried.has(i.fingerprint));
      if (!target) {
        stopReason = insights.length === 0 ? "no_findings" : "no_new_findings";
        break;
      }
      tried.add(target.fingerprint);

      const evidence: InsightEvidence = target.evidence;
      const samples = evidence.conversationIds.slice(0, 3).map((id) => arm.trials[Number(id.replace("trial-", ""))]?.transcript ?? "").filter(Boolean);
      const draft = await this.proposer.propose({ tenantId: EXPERIMENT_TENANT, config, insight: { kind: target.kind, title: target.title, detail: target.detail, facts: evidence.facts }, samples, unrecorded: true });
      if (!draft) {
        stopReason = "proposal_failed";
        break;
      }
      const candidate = applyChanges(config, draft.changes);
      if (JSON.stringify(candidate) === JSON.stringify(config)) {
        stopReason = "no_change";
        break;
      }

      const [guardBefore, guardAfter] = [await this.runArm("guard-before", agent, guardOpts), await this.runArm("guard-after", this.agentWith(baseline, candidate, version + 1), guardOpts)];
      const safe = guardAfter.completed >= guardBefore.completed && preservesHardRules(config.hardRules, candidate.hardRules);
      if (!safe) {
        result.rejected = { fingerprint: target.fingerprint, title: target.title, reason: !preservesHardRules(config.hardRules, candidate.hardRules) ? "would change a hard rule" : `cooperative visitors completed ${guardAfter.completed}/${guardN} (was ${guardBefore.completed}/${guardN})` };
        stopReason = "guard_rejected";
        break;
      }
      result.adopted = { fingerprint: target.fingerprint, title: target.title, rationale: draft.rationale, changes: draft.changes, guard: { baselineCompleted: guardBefore.completed, candidateCompleted: guardAfter.completed, n: guardN } };
      config = candidate;
    }

    const first = rounds[0]!.arm;
    return {
      rounds,
      stopReason,
      cumulative: rounds.slice(1).map((r) => this.compare(first, r.arm, opts.seed)),
      stepwise: rounds.slice(1).map((r, i) => this.compare(rounds[i]!.arm, r.arm, opts.seed)),
    };
  }

  private agentWith(base: SimAgent, c: AgentConfigParts, version: number): SimAgent {
    const config: AgentPromptConfig = { ...base.config, script: c.script, requiredFields: c.requiredFields, hardRules: c.hardRules, spec: c.spec, agentVersion: version };
    return { id: base.id, version, config };
  }
}
