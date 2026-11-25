import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgentSpec, type RequiredFieldsSpec } from "@envoy/types";
import { AppModule } from "../../../app.module.js";
import { LLM_PROVIDER } from "../providers/llm/llm-provider.module.js";
import type { LlmProvider } from "../providers/llm/types.js";
import type { SimAgent } from "../simulation/simulation.service.js";
import { renderReport } from "./report.js";
import { ExperimentRunner } from "./runner.js";
import { LlmVisitor, RuleVisitor, type Persona } from "./visitors.js";

/**
 * The measured "does the agent improve with every run" experiment.
 *
 *   LLM_PROVIDER=mock    pnpm --filter @envoy/api experiment        # synthetic: proves the machinery, free, seconds
 *   LLM_PROVIDER=groq EXPERIMENT_VISITOR=llm EXPERIMENT_CONFIRM_COST=yes \
 *   GROQ_API_KEY=… pnpm --filter @envoy/api experiment              # real model, language-model visitors: spends tokens
 *
 * Settings (all optional): EXPERIMENT_TRIALS (200) visitors per round, EXPERIMENT_ROUNDS (4), EXPERIMENT_SEED,
 * EXPERIMENT_GUARD (12) cooperative visitors per safety check, EXPERIMENT_VISITOR (rule | llm), EXPERIMENT_CONCURRENCY,
 * EXPERIMENT_OUT (report path). Anything other than the mock model refuses to start without EXPERIMENT_CONFIRM_COST=yes,
 * after printing roughly how many model calls it will make.
 */
const env = (k: string, d: string) => process.env[k] ?? d;
const trials = Number(env("EXPERIMENT_TRIALS", "200"));
const rounds = Number(env("EXPERIMENT_ROUNDS", "4"));
const seed = Number(env("EXPERIMENT_SEED", "20260101"));
const guardTrials = Number(env("EXPERIMENT_GUARD", "12"));
const visitorKind = env("EXPERIMENT_VISITOR", "rule") as "rule" | "llm";
const provider = env("LLM_PROVIDER", "mock");

const fields: RequiredFieldsSpec = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone", required: true },
];

const baseline = (): SimAgent => ({
  id: "experiment-agent",
  version: 1,
  config: {
    script: "You help visitors book a product demo. Be friendly and brief.",
    requiredFields: fields,
    hardRules: [{ id: "no-discounts", text: "Never promise discounts or free trials", action: "block", severity: "high" }],
    spec: AgentSpec.parse({ runtime: { mode: "agentic", extractionFallback: false } }),
    agentVersion: 1,
  },
});

/** A rough count of model calls, so the cost of a real run is known before it starts. */
function estimate() {
  const turnsPerTrial = 6;
  const agentCallsPerTurn = 3; // reply (+ a tool round-trip or two) and the rule check
  const conversations = trials * (rounds + 1) + guardTrials * 2 * rounds;
  const agent = conversations * turnsPerTrial * agentCallsPerTurn;
  const visitor = visitorKind === "llm" ? conversations * turnsPerTrial : 0;
  return { conversations, agent, visitor, proposer: rounds * 2, total: agent + visitor + rounds * 2 };
}

describe("experiment: improvement loop", () => {
  it("measures the agent before and after each improvement round, and writes a report", async () => {
    const est = estimate();
    console.log(`\nExperiment: ${trials} visitors × ${rounds + 1} rounds, model=${provider}, visitors=${visitorKind}\nAbout ${est.total.toLocaleString()} model calls (${est.agent.toLocaleString()} agent, ${est.visitor.toLocaleString()} visitor, ${est.proposer} proposer) across ${est.conversations.toLocaleString()} conversations.`);
    if (provider !== "mock" && process.env.EXPERIMENT_CONFIRM_COST !== "yes") {
      throw new Error(`Refusing to run against "${provider}": this makes about ${est.total.toLocaleString()} real model calls. Set EXPERIMENT_CONFIRM_COST=yes to proceed, or lower EXPERIMENT_TRIALS / EXPERIMENT_ROUNDS.`);
    }

    const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    try {
      const runner = app.get(ExperimentRunner);
      const llm = app.get<LlmProvider>(LLM_PROVIDER);
      const visitor = visitorKind === "llm" ? (p: Persona) => new LlmVisitor(p, llm) : (p: Persona) => new RuleVisitor(p);
      const concurrency = Number(env("EXPERIMENT_CONCURRENCY", provider === "mock" ? "8" : "4"));

      const started = Date.now();
      const result = await runner.runLoop(baseline(), { trials, rounds, seed, guardTrials, concurrency, visitor });
      const command = `LLM_PROVIDER=${provider} EXPERIMENT_VISITOR=${visitorKind} EXPERIMENT_TRIALS=${trials} EXPERIMENT_ROUNDS=${rounds} EXPERIMENT_SEED=${seed} pnpm --filter @envoy/api experiment`;
      const md = renderReport(result, { provider, visitor: visitorKind, seed, trialsPerRound: trials, rounds, guardTrials, date: new Date().toISOString().slice(0, 10), command });

      const out = env("EXPERIMENT_OUT", `../../docs/experiments/improvement-loop-${provider}-${visitorKind}.md`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, md);
      const first = result.rounds[0]!.arm;
      const last = result.rounds.at(-1)!.arm;
      console.log(`\nCompletion ${(first.completionRate * 100).toFixed(1)}% → ${(last.completionRate * 100).toFixed(1)}% over ${result.rounds.length - 1} round(s); stopped: ${result.stopReason}; ${((Date.now() - started) / 1000).toFixed(0)}s.\nReport: ${out}\n`);

      // Not a pass/fail on "improved" (a real model may genuinely not improve): only that the experiment ran cleanly.
      expect(result.rounds[0]!.arm.n).toBe(trials);
      expect(result.rounds.reduce((n, r) => n + r.arm.errored, 0)).toBeLessThanOrEqual(Math.ceil(trials * 0.02));
    } finally {
      await app.close();
    }
  });
});
