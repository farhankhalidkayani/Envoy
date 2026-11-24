import { Inject, Injectable, Logger } from "@nestjs/common";
import { AgentSpec, OutcomeType as OutcomeTypeSchema, type GoalProgressMap, type OutcomeType } from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { CrmService } from "../../crm/crm.service.js";
import { IntegrationsService } from "../../integrations/integrations.service.js";
import { FieldExtractorService } from "../capture/field-extractor.service.js";
import { ConversationSessionStore } from "../conversation/conversation-session.store.js";
import { ConversationsService } from "../conversation/conversations.service.js";
import type { AgentPromptConfig } from "../prompt/system-prompt.builder.js";
import { LLM_PROVIDER } from "../providers/llm/llm-provider.module.js";
import { stripCompletionMarker } from "../providers/llm/prompt-markers.js";
import type { LlmMessage, LlmProvider, LlmToolCall } from "../providers/llm/types.js";
import { RuleEnforcerService } from "../rules/rule-enforcer.service.js";
import { buildAgenticMessages } from "./agentic-prompt.js";
import { missingRequiredKeys } from "./built-in-tools.js";
import { currentModelContext, type ModelContext } from "../../models/model-context.js";
import { RunState } from "./run-state.js";
import { TurnRecorder } from "./run-recorder.js";
import { DbRunSink, type RunSink } from "./run-sink.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolServices } from "./tool.js";

/**
 * Passed only by the playground and scenario runner. Side effects go to
 * `sink` instead of the database, and the tenant's CRM/calendar are replaced
 * by `services` (a sandbox) — so a simulation can't book a real meeting,
 * read a real contact, or leave a trace on a real conversation.
 */
export interface SimulationHooks {
  sink: RunSink;
  services: ToolServices;
  /** The caller's own model context, so it can read back token totals and the route taken. */
  modelContext?: ModelContext;
}

export interface AgenticTurnResult {
  visibleText: string;
  outcomeType?: OutcomeType;
  isComplete: boolean;
  capturedData: Record<string, unknown>;
  handoffReason?: string;
  goalProgress: GoalProgressMap;
}

const NO_REPLY_FALLBACK = "Sorry, I'm having trouble with that right now — could you say it another way?";
const CLOSING_FALLBACK = "Thanks for your time — we'll be in touch.";
const HANDOFF_FALLBACK = "I'm passing you to a colleague who will follow up with you shortly.";

/**
 * The agent loop: perceive → think → validate → act → observe, bounded by
 * the spec's step and tool budgets, finishing with the same hard-rule
 * enforcement every classic reply gets. The model proposes tool calls; the
 * ToolRegistry validates, authorises, limits and executes them.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly sessions: ConversationSessionStore,
    private readonly registry: ToolRegistry,
    private readonly ruleEnforcer: RuleEnforcerService,
    private readonly fieldExtractor: FieldExtractorService,
    private readonly conversations: ConversationsService,
    private readonly prisma: PrismaService,
    private readonly crm: CrmService,
    private readonly integrations: IntegrationsService,
  ) {}

  async runTurn(params: {
    conversationId: string;
    tenantId: string;
    config: AgentPromptConfig;
    userText: string;
    simulation?: SimulationHooks;
  }): Promise<AgenticTurnResult> {
    const { conversationId, config } = params;
    const spec = AgentSpec.parse(config.spec ?? {});
    const limits = spec.runtime;

    const userMessage: LlmMessage = { role: "user", content: params.userText };
    const session = await this.sessions.appendMessages(conversationId, [userMessage]);
    const turn = (session.turn ?? 0) + 1;

    const run = new RunState(
      { ...session.capturedData },
      { ...(session.goalProgress ?? {}) },
      { ...(session.toolCallCounts ?? {}) },
    );
    const sink = params.simulation?.sink ?? new DbRunSink(this.prisma, this.conversations, { conversationId, tenantId: params.tenantId });
    const recorder = new TurnRecorder(sink, { turn, startSeq: session.stepSeq ?? 0 });

    // Only look up connections for tools the tenant actually opted into — no extra queries for agents that don't use them.
    const wants = (name: string) => spec.tools.some((t) => t.name === name && t.enabled);
    // A simulation runs against a sandbox, so it needs no real connection to try the tools.
    const connections = params.simulation
      ? { crm: true, calendar: true }
      : {
          crm: wants("lookup_crm_contact") && (await this.crm.getConnection(params.tenantId)) !== null,
          calendar:
            (wants("check_calendar_availability") || wants("book_meeting")) &&
            (await this.integrations.hasCalendar(params.tenantId)),
        };
    const services = params.simulation?.services ?? this.servicesFor(params.tenantId);
    const baseToolConfig = { requiredFields: config.requiredFields, goals: spec.goals, connections };
    const tools = this.registry.resolve(spec, baseToolConfig);
    const toolConfig = this.registry.toolConfig(tools, baseToolConfig);
    const toolDefs = this.registry.definitions(tools);

    const produced: LlmMessage[] = []; // tool-call / tool-result messages this turn, persisted into history
    const buildMessages = (offered: typeof toolDefs) =>
      buildAgenticMessages({
        config,
        spec,
        tools: offered,
        captured: run.capturedData,
        progress: run.goalProgress,
        missingRequired: missingRequiredKeys(toolConfig, run.capturedData),
        history: [...session.history, ...produced],
      });

    let candidate: string | undefined;
    let lastMessages = buildMessages(toolDefs);

    for (let step = 1; step <= limits.maxSteps; step++) {
      const turnBudgetSpent = run.toolCallsThisTurn >= limits.maxToolCallsPerTurn;
      // Once the conversation is ending (or the budget is gone) the model may only write its reply.
      const offered = run.terminal || turnBudgetSpent ? [] : toolDefs;
      lastMessages = buildMessages(offered);

      const started = Date.now();
      let result: Awaited<ReturnType<LlmProvider["completeWithTools"]>>;
      try {
        result = await this.llm.completeWithTools({ messages: lastMessages, tools: offered });
      } catch (err) {
        recorder.record({
          kind: "model",
          name: this.llm.name,
          error: (err as Error).message,
          latencyMs: Date.now() - started,
        });
        this.logger.warn(`model call failed: ${(err as Error).message}`);
        break;
      }
      recorder.record({
        kind: "model",
        name: this.llm.name,
        input: { step, toolsOffered: offered.length },
        output: {
          text: result.text.slice(0, 500),
          toolCalls: result.toolCalls.map((c) => c.name),
          // Which key and model actually answered — "platform" means the shared default.
          route: currentModelContext()?.lastRoute,
          usage: result.usage,
        },
        latencyMs: Date.now() - started,
      });

      if (result.toolCalls.length === 0 || offered.length === 0) {
        candidate = result.text;
        break;
      }

      produced.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        produced.push(await this.runTool(call, { tools, spec, toolConfig, run, limits, recorder, services }));
      }
      if (step === limits.maxSteps) {
        recorder.record({ kind: "limit", name: "max_steps", output: { maxSteps: limits.maxSteps } });
      }
    }

    // Terminal tools may have run in the final step with no text turn left; make sure the visitor still gets a closing line.
    let candidateText = candidate?.trim() ?? "";
    if (!candidateText) {
      candidateText = run.terminal?.kind === "handoff" ? HANDOFF_FALLBACK : run.terminal ? CLOSING_FALLBACK : NO_REPLY_FALLBACK;
    }

    // Same two-layer enforcement as classic replies: nothing reaches the visitor un-judged.
    const { finalText, violations } = await this.ruleEnforcer.enforce({
      candidateText,
      hardRules: config.hardRules,
      messagesForRetry: lastMessages,
      regenerate: async (messages) => (await this.llm.completeWithTools({ messages, tools: [] })).text,
    });
    if (config.hardRules.length > 0) {
      recorder.record({
        kind: "judge",
        name: "hard_rules",
        output: { violations: violations.map((v) => ({ ruleId: v.ruleId, action: v.action })) },
      });
    }
    if (violations.length > 0) await sink.appendViolations(violations);

    const { visibleText } = stripCompletionMarker(finalText);

    if (limits.extractionFallback && config.requiredFields.length > 0) {
      const before = Object.keys(run.capturedData).length;
      run.capturedData = await this.fieldExtractor.extractAndMerge({
        fields: config.requiredFields,
        latestUserMessage: params.userText,
        capturedDataSoFar: run.capturedData,
      });
      const added = Object.keys(run.capturedData).length - before;
      if (added > 0) recorder.record({ kind: "extract", name: "fallback_extraction", output: { fieldsAdded: added } });
    }

    await this.sessions.appendMessages(conversationId, [...produced, { role: "assistant", content: visibleText }]);
    await recorder.flush();
    await this.sessions.patch(conversationId, {
      capturedData: run.capturedData,
      goalProgress: run.goalProgress,
      toolCallCounts: run.toolCallCounts,
      turn,
      stepSeq: recorder.nextSeq,
    });
    if (Object.keys(run.goalProgress).length > 0) await sink.setGoalProgress(run.goalProgress);

    const terminal = run.terminal;
    const outcome = terminal?.kind === "end" ? OutcomeTypeSchema.safeParse(terminal.outcomeType) : undefined;
    return {
      visibleText,
      isComplete: terminal !== undefined,
      outcomeType: outcome?.success ? outcome.data : undefined,
      capturedData: run.capturedData,
      handoffReason: terminal?.kind === "handoff" ? terminal.reason : undefined,
      goalProgress: run.goalProgress,
    };
  }

  /** The tenant's systems bound to this tenant, so a tool can never address another tenant's CRM or calendar. */
  private servicesFor(tenantId: string): ToolServices {
    return {
      lookupCrmContact: (email) => this.crm.lookupContact(tenantId, email),
      getBusyIntervals: (from, to) => this.integrations.getBusyIntervals(tenantId, from, to),
      bookSlot: (req) => this.integrations.bookSlot(tenantId, req),
    };
  }

  private async runTool(
    call: LlmToolCall,
    ctx: {
      tools: ReturnType<ToolRegistry["resolve"]>;
      spec: AgentSpec;
      toolConfig: ReturnType<ToolRegistry["toolConfig"]>;
      run: RunState;
      limits: AgentSpec["runtime"];
      recorder: TurnRecorder;
      services: ToolServices;
    },
  ): Promise<LlmMessage> {
    let outcome;
    let latencyMs = 0;
    if (ctx.run.toolCallsThisTurn >= ctx.limits.maxToolCallsPerTurn) {
      outcome = { ok: false as const, error: "Tool call budget for this turn is used up. Reply to the visitor now." };
      ctx.recorder.record({ kind: "limit", name: "max_tool_calls_per_turn", output: { max: ctx.limits.maxToolCallsPerTurn } });
    } else {
      ({ outcome, latencyMs } = await this.registry.execute({
        tools: ctx.tools,
        call,
        spec: ctx.spec,
        toolConfig: ctx.toolConfig,
        state: ctx.run,
        services: ctx.services,
        timeoutMs: ctx.limits.toolTimeoutMs,
      }));
    }
    ctx.recorder.record({
      kind: "tool",
      name: call.name,
      input: call.arguments,
      output: outcome.ok ? outcome.data ?? { ok: true } : undefined,
      error: outcome.ok ? undefined : outcome.error,
      latencyMs,
    });
    return { role: "tool", toolCallId: call.id, toolName: call.name, content: JSON.stringify(outcome) };
  }
}
