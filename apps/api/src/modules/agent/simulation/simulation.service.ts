import { HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentSpec,
  HardRulesSpec,
  RequiredFieldsSpec,
  ModelConfig,
  evaluateScenario,
  scenarioPassed,
  type GoalProgressMap,
  type OutcomeType,
  type ScenarioCheck,
  type ScenarioDef,
  type ScenarioOutcome,
  type ScenarioSandbox,
} from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { RedisService } from "../../core/redis/redis.service.js";
import type { ModelContext } from "../../models/model-context.js";
import { ConversationEngineService } from "../conversation/conversation-engine.service.js";
import { ConversationSessionStore } from "../conversation/conversation-session.store.js";
import type { AgentPromptConfig } from "../prompt/system-prompt.builder.js";
import type { StepRow } from "../runtime/run-sink.js";
import { MemoryRunSink } from "../runtime/run-sink.js";
import type { ToolServices } from "../runtime/tool.js";

/** A day's worth of simulated visitor messages per workspace. Simulations call the model for real, so they are metered. */
export const DAILY_SIMULATED_TURNS = 400;
const SCENARIO_TIMEOUT_MS = 120_000;

export interface SimAgent {
  id: string;
  version: number;
  config: AgentPromptConfig;
}

export interface SimTurn {
  reply: string;
  isComplete: boolean;
  outcomeType?: OutcomeType;
  handoffReason?: string;
  capturedData: Record<string, unknown>;
  goalProgress: GoalProgressMap;
  steps: StepRow[];
  blockedViolations: number;
}

export interface ScenarioExecution {
  passed: boolean;
  error?: string;
  checks: ScenarioCheck[];
  outcome: ScenarioOutcome;
  transcript: Array<{ role: "visitor" | "agent"; text: string }>;
  steps: StepRow[];
  route?: ModelContext["lastRoute"];
  tokens: { calls: number; inputTokens: number; outputTokens: number };
  latencyMs: number;
}

/**
 * Runs an agent exactly as a visitor would meet it — same engine, same loop,
 * same hard-rule enforcement, same model routing — but with every side effect
 * redirected: no Conversation row, no lead, no CRM push, no stored trace, and
 * tools pointed at a sandbox. That is what makes it safe to run on a live
 * agent, and cheap enough to run before every publish.
 */
@Injectable()
export class SimulationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly engine: ConversationEngineService,
    private readonly sessions: ConversationSessionStore,
  ) {}

  /** Tenant-scoped: another tenant's agent id is a 404, never a simulation. */
  async loadAgent(tenantId: string, agentId: string): Promise<SimAgent> {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId } });
    if (!agent) throw new NotFoundException("Agent not found");
    return {
      id: agent.id,
      version: agent.version,
      config: {
        script: agent.script,
        requiredFields: RequiredFieldsSpec.parse(agent.requiredFields ?? []),
        hardRules: HardRulesSpec.parse(agent.hardRules ?? []),
        spec: AgentSpec.parse(agent.spec ?? {}),
        agentVersion: agent.version,
      },
    };
  }

  /** In-memory CRM and calendar. Bookings made during a run block later bookings of the same slot, like the real thing. */
  sandboxServices(sandbox: ScenarioSandbox): ToolServices {
    const busy = sandbox.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    const overlaps = (from: Date, to: Date) => busy.filter((b) => b.start < to && b.end > from);
    return {
      lookupCrmContact: async (email) => {
        const hit = sandbox.knownContacts.find((c) => c.email.toLowerCase() === email.toLowerCase());
        return hit ? { success: true, found: true, firstName: hit.firstName } : { success: true, found: false };
      },
      getBusyIntervals: async (from, to) => ({
        success: true,
        busy: overlaps(from, to).map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
      }),
      bookSlot: async ({ start, durationMinutes }) => {
        const end = new Date(start.getTime() + (durationMinutes ?? 30) * 60_000);
        if (overlaps(start, end).length > 0) {
          return { success: false, error: "That time is no longer available. Offer the visitor another slot." };
        }
        busy.push({ start, end });
        return { success: true, eventId: `simulated_${start.getTime()}`, start: start.toISOString(), end: end.toISOString() };
      },
    };
  }

  private async meter(tenantId: string): Promise<void> {
    const key = `sim:turns:${tenantId}:${new Date().toISOString().slice(0, 10)}`;
    const used = await this.redis.client.incr(key);
    if (used === 1) await this.redis.client.expire(key, 2 * 86_400);
    if (used > DAILY_SIMULATED_TURNS) {
      throw new HttpException(`Daily simulation limit reached (${DAILY_SIMULATED_TURNS} messages). It resets tomorrow.`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private conversationId(tenantId: string, sessionId: string) {
    return `sim:${tenantId}:${sessionId}`;
  }

  /** One visitor message into a simulated conversation. A new `sessionId` is a new conversation. */
  async turn(params: {
    tenantId: string;
    agent: SimAgent;
    sessionId: string;
    message: string;
    sandbox: ScenarioSandbox;
    services?: ToolServices;
    modelContext?: ModelContext;
    /** Variant model overrides, layered over the agent's own. */
    models?: Partial<ModelConfig>;
    /** Skip the daily message limit. Internal only (the experiment runner, which sets its own budget); never exposed over HTTP. */
    unmetered?: boolean;
  }): Promise<SimTurn> {
    if (!params.unmetered) await this.meter(params.tenantId);
    const conversationId = this.conversationId(params.tenantId, params.sessionId);
    if (!(await this.sessions.get(conversationId))) await this.sessions.init(conversationId);

    const spec = params.agent.config.spec!;
    const agentModels = { ...spec.models, ...(params.models ?? {}) };
    const config: AgentPromptConfig = { ...params.agent.config, spec: { ...spec, models: agentModels } };
    const sink = new MemoryRunSink();
    const modelContext = params.modelContext ?? { tenantId: params.tenantId, agentModels };
    // The context's overrides must match this turn's (a variant changes them between runs).
    modelContext.agentModels = agentModels;

    const result = await this.engine.handleUserMessage({
      conversationId,
      tenantId: params.tenantId,
      config,
      userText: params.message,
      simulation: { sink, services: params.services ?? this.sandboxServices(params.sandbox), modelContext },
    });
    return {
      reply: result.visibleText,
      isComplete: result.isComplete,
      outcomeType: result.outcomeType,
      handoffReason: result.handoffReason,
      capturedData: result.capturedData,
      goalProgress: result.goalProgress ?? {},
      steps: sink.steps,
      blockedViolations: sink.violations.length,
    };
  }

  async reset(tenantId: string, sessionId: string) {
    await this.sessions.clear(this.conversationId(tenantId, sessionId));
  }

  /** Plays a scenario's visitor script to completion (or the end of the script) and grades it. Never throws for model/provider failures — those become a failed run. */
  async runScenario(params: { tenantId: string; agent: SimAgent; scenario: ScenarioDef; models?: Partial<ModelConfig> }): Promise<ScenarioExecution> {
    const started = Date.now();
    const sessionId = `run_${Math.random().toString(36).slice(2, 12)}`;
    const services = this.sandboxServices(params.scenario.sandbox);
    const modelContext: ModelContext = { tenantId: params.tenantId };
    const replies: string[] = [];
    const transcript: ScenarioExecution["transcript"] = [];
    const steps: StepRow[] = [];
    const toolCalls: ScenarioOutcome["toolCalls"] = [];
    let blocked = 0;
    let last: SimTurn | undefined;
    let turnsUsed = 0;
    let error: string | undefined;

    const play = async () => {
      for (const message of params.scenario.turns) {
        turnsUsed += 1;
        transcript.push({ role: "visitor", text: message });
        last = await this.turn({ tenantId: params.tenantId, agent: params.agent, sessionId, message, sandbox: params.scenario.sandbox, services, modelContext, models: params.models });
        replies.push(last.reply);
        transcript.push({ role: "agent", text: last.reply });
        blocked += last.blockedViolations;
        for (const s of last.steps) {
          steps.push(s); // turn and seq already continue across the session
          if (s.kind === "tool") toolCalls.push({ name: s.name, ok: !s.error });
        }
        if (last.isComplete) break;
      }
    };

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        play(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The scenario timed out after 2 minutes.")), SCENARIO_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // A quota/rate-limit on the daily meter is the caller's problem to see, not a failed scenario.
      if (err instanceof HttpException) throw err;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      await this.reset(params.tenantId, sessionId).catch(() => {});
    }

    const outcome: ScenarioOutcome = {
      replies,
      turnsUsed,
      completed: last?.isComplete ?? false,
      outcomeType: last?.outcomeType,
      handoffReason: last?.handoffReason,
      capturedData: last?.capturedData ?? {},
      toolCalls,
      goalProgress: Object.fromEntries(Object.entries(last?.goalProgress ?? {}).map(([k, v]) => [k, { status: v.status }])),
      blockedViolations: blocked,
    };
    const checks = evaluateScenario(params.scenario.expect, outcome);
    return {
      // A run that errored can't be called passing, even if it had no expectations to fail.
      passed: !error && scenarioPassed(checks),
      error,
      checks,
      outcome,
      transcript,
      steps,
      route: modelContext.lastRoute,
      tokens: modelContext.totals ?? { calls: 0, inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
    };
  }
}
