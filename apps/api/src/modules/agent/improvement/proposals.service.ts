import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import {
  AgentSpec,
  HardRulesSpec,
  ProposalChanges,
  RequiredFieldsSpec,
  ScenarioDef,
  applyChanges,
  preservesHardRules,
  type AgentConfigParts,
  type InsightEvidence,
} from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { AgentsService } from "../agents.service.js";
import { SimulationService, type ScenarioExecution, type SimAgent } from "../simulation/simulation.service.js";
import { ImprovementService } from "./improvement.service.js";
import { ProposerService } from "./proposer.js";

const MAX_OPEN_PROPOSALS = 5;
const MAX_TEST_SCENARIOS = 20;
const MAX_REPLAYS = 3;
const SAMPLE_CHARS = 1500;

interface Side {
  completed: boolean;
  captured: number;
}

export interface ProposalTestResult {
  testedAt: string;
  scenarios: {
    total: number;
    baselinePassed: number;
    candidatePassed: number;
    /** Passed on the current config, fails on the proposal — the reason a proposal can be unsafe. */
    regressions: Array<{ scenario: string; failed: Array<{ check: string; detail: string }> }>;
    fixed: string[];
  };
  /** The same visitors from real conversations, replayed against both configurations. */
  replay: { total: number; baselineCompleted: number; candidateCompleted: number; items: Array<{ conversationId: string; baseline: Side; candidate: Side }> };
  hardRulesPreserved: boolean;
  /** No regressions and every hard rule intact. Only a safe proposal can be approved. */
  safe: boolean;
}

const visitorTurns = (transcript: string) =>
  transcript.split("\n").filter((l) => l.startsWith("Visitor: ")).map((l) => l.slice("Visitor: ".length).trim()).filter(Boolean).slice(0, 20);

@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly improvement: ImprovementService,
    private readonly proposer: ProposerService,
    private readonly simulation: SimulationService,
  ) {}

  private async scoped(tenantId: string, agentId: string, id: string) {
    const proposal = await this.prisma.client.proposal.findFirst({ where: { id, agentId, tenantId } });
    if (!proposal) throw new NotFoundException("Proposal not found");
    return proposal;
  }

  private configOf(agent: { script: string; requiredFields: unknown; hardRules: unknown; spec: unknown }): AgentConfigParts {
    return {
      script: agent.script,
      requiredFields: RequiredFieldsSpec.parse(agent.requiredFields ?? []),
      hardRules: HardRulesSpec.parse(agent.hardRules ?? []),
      spec: AgentSpec.parse(agent.spec ?? {}),
    };
  }

  private view<T extends { baseVersion: number }>(proposal: T, currentVersion: number) {
    // A proposal is only meaningful against the version it was drafted for.
    return { ...proposal, stale: proposal.baseVersion !== currentVersion };
  }

  async list(tenantId: string, agentId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId }, select: { version: true } });
    if (!agent) throw new NotFoundException("Agent not found");
    const rows = await this.prisma.client.proposal.findMany({ where: { agentId, tenantId }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((p) => this.view(p, agent.version));
  }

  async get(tenantId: string, agentId: string, id: string) {
    const agent = await this.prisma.client.agent.findFirstOrThrow({ where: { id: agentId, tenantId }, select: { version: true } }).catch(() => {
      throw new NotFoundException("Agent not found");
    });
    return this.view(await this.scoped(tenantId, agentId, id), agent.version);
  }

  /** Drafts a fix for one insight. Changes nothing about the agent. */
  async create(tenantId: string, agentId: string, insightId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId } });
    if (!agent) throw new NotFoundException("Agent not found");
    const insight = await this.improvement.getInsight(tenantId, agentId, insightId);
    if (insight.agentVersion !== agent.version) throw new ConflictException("This finding is from an older version of the agent. Run the analysis again.");
    if (insight.status !== "open") throw new BadRequestException("This finding was dismissed.");

    const undecided = await this.prisma.client.proposal.count({ where: { agentId, tenantId, baseVersion: agent.version, status: { in: ["pending", "tested"] } } });
    if (undecided >= MAX_OPEN_PROPOSALS) throw new BadRequestException(`There are already ${MAX_OPEN_PROPOSALS} proposals waiting on a decision. Approve or reject some first.`);

    const evidence = insight.evidence as unknown as InsightEvidence;
    const samples = (await this.improvement.evidenceTranscripts(tenantId, agentId, evidence, MAX_REPLAYS)).map((t) => t.text.slice(0, SAMPLE_CHARS));
    const config = this.configOf(agent);
    const draft = await this.proposer.propose({
      tenantId,
      config,
      insight: { kind: insight.kind, title: insight.title, detail: insight.detail, facts: evidence.facts },
      samples,
    });
    if (!draft) throw new BadGatewayException("The model couldn't produce a usable proposal. Try again, or connect a stronger model under AI models.");

    return this.view(
      await this.prisma.client.proposal.create({
        data: { tenantId, agentId, insightId, baseVersion: agent.version, changes: draft.changes as Prisma.InputJsonValue, rationale: draft.rationale },
      }),
      agent.version,
    );
  }

  private pass = (e: ScenarioExecution) => e.passed;

  /**
   * Proves a proposal before anyone is asked to approve it: every scenario runs on the current configuration and on
   * the proposed one, and the visitors from the conversations that exposed the problem are replayed on both. A
   * scenario that passed before and fails now is a regression, and a proposal with any regression can't be approved.
   */
  async test(tenantId: string, agentId: string, id: string) {
    const proposal = await this.scoped(tenantId, agentId, id);
    if (proposal.status === "approved" || proposal.status === "rejected") throw new BadRequestException(`This proposal was already ${proposal.status}.`);
    const base = await this.simulation.loadAgent(tenantId, agentId);
    if (proposal.baseVersion !== base.version) throw new ConflictException("The agent has changed since this was proposed. Ask for a new proposal.");

    const changes = ProposalChanges.parse(proposal.changes);
    const baselineConfig = this.configOf({ ...base.config, spec: base.config.spec });
    const candidateConfig = applyChanges(baselineConfig, changes);
    const withConfig = (c: AgentConfigParts): SimAgent => ({ ...base, config: { ...base.config, ...c } });
    const baseline = withConfig(baselineConfig);
    const candidate = withConfig(candidateConfig);

    const rows = await this.prisma.client.scenario.findMany({ where: { agentId, tenantId }, orderBy: { createdAt: "asc" }, take: MAX_TEST_SCENARIOS });
    const scenarios = rows.map((r) => ({ name: r.name, def: ScenarioDef.parse({ name: r.name, turns: r.turns, expect: r.expect ?? {}, sandbox: r.sandbox ?? {} }) }));

    const regressions: ProposalTestResult["scenarios"]["regressions"] = [];
    const fixed: string[] = [];
    let baselinePassed = 0;
    let candidatePassed = 0;
    for (const s of scenarios) {
      const before = await this.simulation.runScenario({ tenantId, agent: baseline, scenario: s.def });
      const after = await this.simulation.runScenario({ tenantId, agent: candidate, scenario: s.def });
      if (this.pass(before)) baselinePassed++;
      if (this.pass(after)) candidatePassed++;
      if (this.pass(before) && !this.pass(after)) {
        regressions.push({ scenario: s.name, failed: after.checks.filter((c) => !c.passed).map((c) => ({ check: c.name, detail: c.detail })).concat(after.error ? [{ check: "Run", detail: after.error }] : []) });
      }
      if (!this.pass(before) && this.pass(after)) fixed.push(s.name);
    }

    const evidence = proposal.insightId ? ((await this.prisma.client.insight.findUnique({ where: { id: proposal.insightId } }))?.evidence as unknown as InsightEvidence | undefined) : undefined;
    const transcripts = evidence ? await this.improvement.evidenceTranscripts(tenantId, agentId, evidence, MAX_REPLAYS) : [];
    const replayItems: ProposalTestResult["replay"]["items"] = [];
    for (const t of transcripts) {
      const turns = visitorTurns(t.text);
      if (turns.length === 0) continue;
      const def = ScenarioDef.parse({ name: "Replay", turns });
      const [b, c] = [await this.simulation.runScenario({ tenantId, agent: baseline, scenario: def }), await this.simulation.runScenario({ tenantId, agent: candidate, scenario: def })];
      const side = (e: ScenarioExecution): Side => ({ completed: e.outcome.completed, captured: Object.keys(e.outcome.capturedData).length });
      replayItems.push({ conversationId: t.id, baseline: side(b), candidate: side(c) });
    }

    const hardRulesPreserved = preservesHardRules(baselineConfig.hardRules, candidateConfig.hardRules);
    const result: ProposalTestResult = {
      testedAt: new Date().toISOString(),
      scenarios: { total: scenarios.length, baselinePassed, candidatePassed, regressions, fixed },
      replay: {
        total: replayItems.length,
        baselineCompleted: replayItems.filter((i) => i.baseline.completed).length,
        candidateCompleted: replayItems.filter((i) => i.candidate.completed).length,
        items: replayItems,
      },
      hardRulesPreserved,
      safe: regressions.length === 0 && hardRulesPreserved,
    };
    const updated = await this.prisma.client.proposal.update({ where: { id }, data: { status: "tested", testResult: result as unknown as Prisma.InputJsonValue } });
    return this.view(updated, base.version);
  }

  /** Applies the proposal as a new agent version. The only path by which the harness changes a live agent — and it needs a person. */
  async approve(tenantId: string, agentId: string, id: string, actorUserId: string, opts: { acknowledgeUntested?: boolean }) {
    const proposal = await this.scoped(tenantId, agentId, id);
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId } });
    if (!agent) throw new NotFoundException("Agent not found");
    if (proposal.status !== "tested") throw new BadRequestException(proposal.status === "pending" ? "Test this proposal before approving it." : `This proposal was already ${proposal.status}.`);
    if (proposal.baseVersion !== agent.version) throw new ConflictException("The agent has changed since this was proposed. Ask for a new proposal.");

    const result = proposal.testResult as unknown as ProposalTestResult;
    if (!result.safe) throw new ConflictException("This proposal breaks scenarios that pass today, so it can't be approved.");
    if (result.scenarios.total === 0 && !opts.acknowledgeUntested) {
      throw new BadRequestException("This agent has no scenarios, so the proposal couldn't be checked for regressions. Add scenarios, or approve knowing it is untested.");
    }

    const next = applyChanges(this.configOf(agent), ProposalChanges.parse(proposal.changes));
    // Defence in depth: the proposal schema already can't remove a rule, but the invariant is checked at the point of change.
    if (!preservesHardRules(HardRulesSpec.parse(agent.hardRules ?? []), next.hardRules)) throw new ConflictException("A proposal may never remove or weaken a hard rule.");

    const insightTitle = proposal.insightId ? (await this.prisma.client.insight.findUnique({ where: { id: proposal.insightId }, select: { title: true } }))?.title : undefined;
    const updated = await this.agents.update(tenantId, agentId, {
      script: next.script,
      requiredFields: next.requiredFields as unknown as Prisma.InputJsonValue,
      hardRules: next.hardRules as unknown as Prisma.InputJsonValue,
      spec: next.spec as unknown as Prisma.InputJsonValue,
      note: `Improvement: ${insightTitle ?? proposal.rationale}`.slice(0, 200),
    });
    await this.prisma.client.proposal.update({ where: { id }, data: { status: "approved", appliedVersion: updated.version, decidedBy: actorUserId, decidedAt: new Date() } });
    return { appliedVersion: updated.version };
  }

  async reject(tenantId: string, agentId: string, id: string, actorUserId: string) {
    const proposal = await this.scoped(tenantId, agentId, id);
    if (proposal.status === "approved" || proposal.status === "rejected") throw new BadRequestException(`This proposal was already ${proposal.status}.`);
    await this.prisma.client.proposal.update({ where: { id }, data: { status: "rejected", decidedBy: actorUserId, decidedAt: new Date() } });
    return { rejected: true };
  }
}
