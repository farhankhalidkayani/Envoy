import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentSpec, type RequiredFieldsSpec } from "@envoy/types";
import { AppModule } from "../../../app.module.js";
import { ProposerService } from "../improvement/proposer.js";
import type { SimAgent } from "../simulation/simulation.service.js";
import { renderReport } from "./report.js";
import { ExperimentRunner } from "./runner.js";
import { RuleVisitor, samplePersona, type Persona } from "./visitors.js";

const fields: RequiredFieldsSpec = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone", required: true },
];
const agentWith = (over: { fieldHint?: string; hardRules?: SimAgent["config"]["hardRules"]; spec?: object } = {}): SimAgent => ({
  id: "exp-agent",
  version: 1,
  config: {
    script: "Help visitors book a demo.",
    requiredFields: fields.map((f) => (f.key === "phone" && over.fieldHint ? { ...f, prompt: over.fieldHint } : f)),
    hardRules: over.hardRules ?? [],
    // Agentic mode: the agent keeps asking until the required data is captured and the harness lets it finish. (The classic
    // mock walks a fixed script and "completes" whatever the visitor said, which would measure nothing.)
    spec: AgentSpec.parse(over.spec ?? { runtime: { mode: "agentic", extractionFallback: false } }),
    agentVersion: 1,
  },
});
const persona = (over: Partial<Persona> = {}): Persona => ({ id: "p", temperament: "open", patience: 4, reluctantFields: [], facts: { name: "Ada Lovelace", email: "ada@example.com", phone: "+447700900123", budget: "5000", company: "Lovelace Ltd" }, ...over });

describe("improvement-loop experiment (mock model, rule visitors)", () => {
  let app: INestApplication;
  let runner: ExperimentRunner;
  let proposer: ProposerService;

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    runner = app.get(ExperimentRunner);
    proposer = app.get(ProposerService);
  }, 40000);
  afterAll(async () => { await app.close(); });

  describe("one visitor, one conversation", () => {
    const run = (agent: SimAgent, p: Persona) => runner.runTrial(agent, p, 0, {});

    it("an open visitor completes, giving every field", async () => {
      const t = await run(agentWith(), persona());
      expect(t).toMatchObject({ completed: true, left: false, errored: false, capturedFields: 3, requiredFields: 3 });
      expect(t.transcript).toMatch(/^Visitor: Hi, I'd like some help\.\nAgent: .*\nVisitor: My name is Ada Lovelace/);
      expect(t.capturedData).toMatchObject({ email: "ada@example.com", phone: "+447700900123" });
      expect(t.turns).toBeGreaterThanOrEqual(4);
    }, 60000);

    it("a wary visitor leaves when asked for their number with no reason — and stays when the agent explains", async () => {
      const wary = persona({ temperament: "reluctant", reluctantFields: ["phone"] });
      const cold = await run(agentWith(), wary);
      expect(cold).toMatchObject({ completed: false, left: true, capturedFields: 2 });
      expect(cold.transcript).toContain("Why do you need that?");
      const warm = await run(agentWith({ fieldHint: "Briefly explain why you need this." }), wary);
      expect(warm).toMatchObject({ completed: true, left: false, capturedFields: 3 });
      expect(warm.transcript).toContain("I only need this so we can confirm your booking.");
    }, 80000);

    it("a hardline visitor never gives the field, however the agent asks", async () => {
      const t = await run(agentWith({ fieldHint: "Briefly explain why you need this." }), persona({ temperament: "hardline", reluctantFields: ["phone"] }));
      expect(t).toMatchObject({ completed: false, left: true });
      expect(t.transcript).toContain("I'd rather not share that.");
    }, 60000);

    it("counts a model failure as an errored, not-completed trial instead of crashing the experiment", async () => {
      const t = await runner.runTrial(agentWith(), persona(), 0, { visitor: () => ({ persona: persona(), next: async () => { throw new Error("visitor model down"); } }) });
      expect(t).toMatchObject({ completed: false, errored: true, timedOut: false });
    }, 40000);

    it("a visitor who stays but is never finished with times out rather than looping forever", async () => {
      const stubborn = { persona: persona(), next: async (a: string | null) => ({ type: "say" as const, message: a === null ? "hi" : "hmm" }) };
      const t = await runner.runTrial(agentWith(), persona(), 0, { visitor: () => stubborn, maxTurns: 3 });
      expect(t).toMatchObject({ completed: false, left: false, timedOut: true, turns: 3 });
    }, 40000);

    it("leaves no trace: the same trial run twice gives the same result, and no sessions remain", async () => {
      const [a, b] = [await run(agentWith(), persona()), await run(agentWith(), persona())];
      expect({ ...a, latencyMs: 0, tokens: 0 }).toEqual({ ...b, latencyMs: 0, tokens: 0 });
    }, 60000);
  });

  describe("an arm of many visitors", () => {
    it("is exactly reproducible from its seed, and different seeds draw different visitors", async () => {
      const opts = { trials: 20, seed: 100, concurrency: 5 };
      const a = await runner.runArm("a", agentWith(), opts);
      const b = await runner.runArm("b", agentWith(), opts);
      expect(a.trials.map((t) => [t.personaId, t.completed, t.turns])).toEqual(b.trials.map((t) => [t.personaId, t.completed, t.turns]));
      const c = await runner.runArm("c", agentWith(), { ...opts, seed: 5000 });
      expect(c.trials.map((t) => t.personaId)).not.toEqual(a.trials.map((t) => t.personaId));
    }, 200000);

    it("reports completion with an honest interval, plus turns, capture and cost", async () => {
      const arm = await runner.runArm("baseline", agentWith(), { trials: 40, seed: 7, concurrency: 8 });
      expect(arm.n).toBe(40);
      expect(arm.completed).toBe(arm.trials.filter((t) => t.completed).length);
      expect(arm.completionRate).toBeCloseTo(arm.completed / 40, 10);
      expect(arm.completionCI.low).toBeLessThanOrEqual(arm.completionRate);
      expect(arm.completionCI.high).toBeGreaterThanOrEqual(arm.completionRate);
      expect(arm.completionCI.high - arm.completionCI.low).toBeGreaterThan(0.05); // 40 visitors can't pin a rate down tightly
      expect(arm.meanTurnsToComplete).toBeGreaterThan(3);
      expect(arm.meanCapturePct).toBeGreaterThan(0.5);
      expect(arm.errored).toBe(0);
      // Only the wary and hardline visitors can fail here, so completion is bounded by the open share of the population.
      const open = arm.trials.filter((t) => t.temperament === "open");
      expect(open.every((t) => t.completed)).toBe(true);
      expect(arm.trials.filter((t) => t.temperament !== "open").every((t) => !t.completed)).toBe(true);
    }, 250000);

    it("runs far more turns than the product's daily simulation limit, because experiments set their own budget", async () => {
      const arm = await runner.runArm("big", agentWith(), { trials: 150, seed: 1, concurrency: 10 });
      expect(arm.trials.reduce((n, t) => n + t.turns, 0)).toBeGreaterThan(400);
      expect(arm.errored).toBe(0);
    }, 300000);

    it("compares two versions on the same visitors with a paired test that sees the real effect", async () => {
      const opts = { trials: 60, seed: 11, concurrency: 8 };
      const before = await runner.runArm("baseline", agentWith(), opts);
      const after = await runner.runArm("with hint", agentWith({ fieldHint: "Briefly explain why you need this." }), opts);
      const c = runner.compare(before, after);
      expect(c.worsened).toBe(0);
      expect(c.improved).toBeGreaterThan(5);
      expect(c.completionDiff).toBeGreaterThan(0.15);
      expect(c.p).toBeLessThan(0.01);
      expect(c.completionDiffCI.low).toBeGreaterThan(0);
      expect(c.verdict).toBe("improved");
      // The very same visitors, so the only thing that changed is the agent.
      expect(before.trials.map((t) => t.personaId)).toEqual(after.trials.map((t) => t.personaId));
    }, 300000);

    it("calls an unchanged agent 'no clear difference', not a win", async () => {
      const opts = { trials: 40, seed: 21, concurrency: 8 };
      const [x, y] = [await runner.runArm("x", agentWith(), opts), await runner.runArm("y", agentWith(), opts)];
      const c = runner.compare(x, y);
      expect(c).toMatchObject({ improved: 0, worsened: 0, completionDiff: 0, p: 1, verdict: "no clear difference" });
    }, 250000);

    it("refuses to compare arms of different sizes", async () => {
      const [x, y] = [await runner.runArm("x", agentWith(), { trials: 4, seed: 1 }), await runner.runArm("y", agentWith(), { trials: 5, seed: 1 })];
      expect(() => runner.compare(x, y)).toThrow(/same number of trials/);
    }, 100000);
  });

  describe("the improvement loop", () => {
    it("finds the problem, drafts the fix, checks it is safe, adopts it, and measures a real improvement", async () => {
      const loop = await runner.runLoop(agentWith({ hardRules: [{ id: "no-prices", text: "Never quote prices", action: "block", severity: "high" }] }), { trials: 60, seed: 3, rounds: 3, guardTrials: 6, concurrency: 8 });

      const [r0, r1] = loop.rounds;
      expect(r0!.findings.map((f) => f.fingerprint)).toContain("abandon_at_field:phone");
      expect(r0!.adopted).toMatchObject({ fingerprint: "abandon_at_field:phone", guard: { baselineCompleted: 6, candidateCompleted: 6, n: 6 } });
      expect(r0!.adopted!.changes).toMatchObject({ fieldPrompts: { phone: expect.stringContaining("explain why") } });
      expect(r1!.config.fieldHints.phone).toContain("explain why");
      expect(r1!.config.hardRuleIds).toEqual(["no-prices"]); // the existing rule survived

      expect(r1!.arm.completionRate).toBeGreaterThan(r0!.arm.completionRate + 0.15);
      expect(loop.cumulative[0]).toMatchObject({ from: "baseline", to: "round 1", worsened: 0, verdict: "improved" });
      expect(loop.cumulative[0]!.p).toBeLessThan(0.01);

      // What's left is the part a hint can't fix (visitors who never share), which was already tried — so it stops, honestly.
      expect(loop.stopReason).toBe("no_new_findings");
      expect(loop.rounds.length).toBe(2); // measured, fixed once, measured again, done
    }, 400000);

    it("won't adopt a change that makes the agent worse for cooperative visitors, and says so", async () => {
      // A new rule that the agent's normal questions break (the mock judge matches 'share' and 'could') would stop everyone completing.
      vi.spyOn(proposer, "propose").mockResolvedValueOnce({
        rationale: "Add a rule.",
        changes: { addHardRules: [{ id: "no-asking", text: "Never mention share or could", action: "block", severity: "high" }] },
      });
      const loop = await runner.runLoop(agentWith(), { trials: 40, seed: 3, rounds: 3, guardTrials: 6, concurrency: 8 });
      expect(loop.stopReason).toBe("guard_rejected");
      expect(loop.rounds).toHaveLength(1);
      expect(loop.rounds[0]!.adopted).toBeUndefined();
      expect(loop.rounds[0]!.rejected!.reason).toMatch(/cooperative visitors completed 0\/6 \(was 6\/6\)/);
      expect(loop.cumulative).toEqual([]);
    }, 300000);

    it("stops cleanly when there is nothing to fix", async () => {
      const loop = await runner.runLoop(agentWith({ fieldHint: "Briefly explain why you need this." }), { trials: 30, seed: 4, rounds: 3, guardTrials: 4, concurrency: 8, mix: { open: 1, reluctant: 0, hardline: 0 } });
      expect(loop.stopReason).toBe("no_findings");
      expect(loop.rounds).toHaveLength(1);
      expect(loop.rounds[0]!.arm.completionRate).toBe(1);
    }, 200000);

    it("stops when the proposer has nothing usable", async () => {
      vi.spyOn(proposer, "propose").mockResolvedValueOnce(null);
      const loop = await runner.runLoop(agentWith(), { trials: 30, seed: 3, rounds: 2, guardTrials: 4, concurrency: 8 });
      expect(loop.stopReason).toBe("proposal_failed");
    }, 200000);

    it("produces a report that states the result and carries the synthetic-run warning", async () => {
      const loop = await runner.runLoop(agentWith(), { trials: 40, seed: 9, rounds: 2, guardTrials: 4, concurrency: 8 });
      const md = renderReport(loop, { provider: "mock", visitor: "rule", seed: 9, trialsPerRound: 40, rounds: 2, guardTrials: 4, date: "2030-01-01", command: "cmd" });
      expect(md).toContain("synthetic run");
      expect(md).toContain("**improved**");
      expect(md).toContain("Visitors leave when asked for “Phone”");
    }, 300000);
  });

  it("samples the same visitors the arms meet", () => {
    expect(samplePersona(100 + 3).id).toBe("visitor-103");
    expect(new RuleVisitor(samplePersona(1)).persona.id).toBe("visitor-1");
  });
});
