import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { ModelConfig, ScenarioDef, ScenarioExpectation, ScenarioSandbox } from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { SimulationService, type ScenarioExecution } from "./simulation.service.js";

const MAX_SCENARIOS_PER_AGENT = 50;
const MAX_SCENARIOS_PER_RUN = 20;
const MAX_VARIANTS = 3;

export interface RunVariant {
  /** Shown in results, e.g. "Claude Opus". "current" is the agent as configured. */
  label: string;
  /** Model overrides for this variant, layered over the agent's own. Omit for "as configured". */
  models?: Partial<ModelConfig>;
}

@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly simulation: SimulationService,
  ) {}

  private async agentScoped(tenantId: string, agentId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId }, select: { id: true, version: true } });
    if (!agent) throw new NotFoundException("Agent not found");
    return agent;
  }

  private async scenarioScoped(tenantId: string, agentId: string, id: string) {
    const scenario = await this.prisma.client.scenario.findFirst({ where: { id, agentId, tenantId } });
    if (!scenario) throw new NotFoundException("Scenario not found");
    return scenario;
  }

  private toDef(row: { name: string; description: string | null; turns: unknown; expect: unknown; sandbox: unknown }): ScenarioDef {
    return ScenarioDef.parse({ name: row.name, description: row.description ?? undefined, turns: row.turns, expect: row.expect ?? {}, sandbox: row.sandbox ?? {} });
  }

  /** Scenarios with their latest run on the agent's CURRENT version, so "passing" can't be stale. */
  async list(tenantId: string, agentId: string) {
    const agent = await this.agentScoped(tenantId, agentId);
    const scenarios = await this.prisma.client.scenario.findMany({ where: { agentId, tenantId }, orderBy: { createdAt: "asc" } });
    const lastRuns = await Promise.all(
      scenarios.map((s) =>
        this.prisma.client.scenarioRun.findFirst({
          where: { scenarioId: s.id, variant: "current" },
          orderBy: { createdAt: "desc" },
          select: { id: true, passed: true, error: true, agentVersion: true, createdAt: true },
        }),
      ),
    );
    return scenarios.map((s, i) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      turns: s.turns as string[],
      expect: s.expect,
      sandbox: s.sandbox,
      createdAt: s.createdAt,
      lastRun: lastRuns[i] ? { ...lastRuns[i]!, onCurrentVersion: lastRuns[i]!.agentVersion === agent.version } : null,
    }));
  }

  async create(tenantId: string, agentId: string, def: ScenarioDef) {
    await this.agentScoped(tenantId, agentId);
    if ((await this.prisma.client.scenario.count({ where: { agentId, tenantId } })) >= MAX_SCENARIOS_PER_AGENT) {
      throw new BadRequestException(`An agent can have at most ${MAX_SCENARIOS_PER_AGENT} scenarios.`);
    }
    return this.prisma.client.scenario.create({
      data: {
        tenantId,
        agentId,
        name: def.name,
        description: def.description,
        turns: def.turns,
        expect: def.expect as Prisma.InputJsonValue,
        sandbox: def.sandbox as Prisma.InputJsonValue,
      },
    });
  }

  async update(tenantId: string, agentId: string, id: string, patch: Partial<ScenarioDef>) {
    const existing = await this.scenarioScoped(tenantId, agentId, id);
    const def = ScenarioDef.parse({ ...this.toDef(existing), ...patch });
    return this.prisma.client.scenario.update({
      where: { id },
      data: { name: def.name, description: def.description ?? null, turns: def.turns, expect: def.expect as Prisma.InputJsonValue, sandbox: def.sandbox as Prisma.InputJsonValue },
    });
  }

  async remove(tenantId: string, agentId: string, id: string) {
    await this.scenarioScoped(tenantId, agentId, id);
    await this.prisma.client.scenario.delete({ where: { id } });
  }

  /**
   * Runs scenarios sequentially (parallel runs would hammer the tenant's
   * model key and the daily meter) for each variant, storing every run. Each
   * variant is the same suite on a different model — that's the comparison.
   */
  async run(tenantId: string, agentId: string, opts: { scenarioIds?: string[]; variants?: RunVariant[] }) {
    await this.agentScoped(tenantId, agentId);
    const variants = opts.variants?.length ? opts.variants : [{ label: "current" }];
    if (variants.length > MAX_VARIANTS) throw new BadRequestException(`Compare at most ${MAX_VARIANTS} setups at a time.`);
    if (new Set(variants.map((v) => v.label)).size !== variants.length) throw new BadRequestException("Each setup needs a different label.");

    const rows = await this.prisma.client.scenario.findMany({
      where: { agentId, tenantId, ...(opts.scenarioIds ? { id: { in: opts.scenarioIds } } : {}) },
      orderBy: { createdAt: "asc" },
    });
    if (opts.scenarioIds && rows.length !== new Set(opts.scenarioIds).size) throw new NotFoundException("Scenario not found");
    if (rows.length === 0) throw new BadRequestException("This agent has no scenarios yet.");
    if (rows.length > MAX_SCENARIOS_PER_RUN) throw new BadRequestException(`Run at most ${MAX_SCENARIOS_PER_RUN} scenarios at a time.`);

    const agent = await this.simulation.loadAgent(tenantId, agentId);
    const results: Array<{ variant: string; scenarioId: string; name: string; runId: string } & Pick<ScenarioExecution, "passed" | "error" | "checks" | "tokens" | "latencyMs">> = [];

    for (const variant of variants) {
      for (const row of rows) {
        const def = this.toDef(row);
        const execution = await this.simulation.runScenario({ tenantId, agent, scenario: def, models: variant.models });
        const run = await this.prisma.client.scenarioRun.create({
          data: {
            tenantId,
            agentId,
            scenarioId: row.id,
            agentVersion: agent.version,
            variant: variant.label,
            passed: execution.passed,
            error: execution.error,
            latencyMs: execution.latencyMs,
            inputTokens: execution.tokens.inputTokens,
            outputTokens: execution.tokens.outputTokens,
            result: {
              name: row.name,
              transcript: execution.transcript,
              checks: execution.checks,
              outcome: execution.outcome,
              steps: execution.steps,
              route: execution.route ?? null,
              tokens: execution.tokens,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        results.push({ variant: variant.label, scenarioId: row.id, name: row.name, runId: run.id, passed: execution.passed, error: execution.error, checks: execution.checks, tokens: execution.tokens, latencyMs: execution.latencyMs });
      }
    }

    return {
      agentVersion: agent.version,
      variants: variants.map((v) => {
        const mine = results.filter((r) => r.variant === v.label);
        return {
          label: v.label,
          passed: mine.filter((r) => r.passed).length,
          total: mine.length,
          inputTokens: mine.reduce((n, r) => n + r.tokens.inputTokens, 0),
          outputTokens: mine.reduce((n, r) => n + r.tokens.outputTokens, 0),
          avgLatencyMs: mine.length ? Math.round(mine.reduce((n, r) => n + r.latencyMs, 0) / mine.length) : 0,
        };
      }),
      results,
    };
  }

  /** Is the agent's CURRENT version covered and passing? The publish gate reads this. */
  async status(tenantId: string, agentId: string) {
    const agent = await this.agentScoped(tenantId, agentId);
    const scenarios = await this.prisma.client.scenario.findMany({ where: { agentId, tenantId }, select: { id: true } });
    let passing = 0;
    let failing = 0;
    for (const s of scenarios) {
      const run = await this.prisma.client.scenarioRun.findFirst({
        where: { scenarioId: s.id, variant: "current", agentVersion: agent.version },
        orderBy: { createdAt: "desc" },
        select: { passed: true },
      });
      if (run?.passed) passing += 1;
      else if (run) failing += 1;
    }
    return { agentVersion: agent.version, total: scenarios.length, passing, failing, notRun: scenarios.length - passing - failing };
  }

  async history(tenantId: string, agentId: string, limit: number) {
    await this.agentScoped(tenantId, agentId);
    return this.prisma.client.scenarioRun.findMany({
      where: { agentId, tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getRun(tenantId: string, agentId: string, runId: string) {
    const run = await this.prisma.client.scenarioRun.findFirst({ where: { id: runId, agentId, tenantId } });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }
}

// Re-exported so the controller validates with the very schemas the evaluator uses.
export { ScenarioDef, ScenarioExpectation, ScenarioSandbox };
