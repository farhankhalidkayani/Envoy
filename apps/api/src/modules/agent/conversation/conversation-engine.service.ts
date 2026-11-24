import { Inject, Injectable } from "@nestjs/common";
import type { GoalProgressMap, OutcomeType } from "@envoy/types";
import { OutcomeType as OutcomeTypeSchema } from "@envoy/types";
import { FieldExtractorService } from "../capture/field-extractor.service.js";
import {
  buildChatMessages,
  type AgentPromptConfig,
} from "../prompt/system-prompt.builder.js";
import { LLM_PROVIDER } from "../providers/llm/llm-provider.module.js";
import { stripCompletionMarker } from "../providers/llm/prompt-markers.js";
import type { LlmMessage, LlmProvider } from "../providers/llm/types.js";
import { runWithModelContext } from "../../models/model-context.js";
import { RuleEnforcerService } from "../rules/rule-enforcer.service.js";
import { AgentLoopService, type SimulationHooks } from "../runtime/agent-loop.service.js";
import { ConversationSessionStore } from "./conversation-session.store.js";
import { ConversationsService } from "./conversations.service.js";

export interface TurnResult {
  visibleText: string;
  outcomeType?: OutcomeType;
  isComplete: boolean;
  capturedData: Record<string, unknown>;
  /** Set when the agent handed the visitor to a human (agentic runtime only). */
  handoffReason?: string;
  goalProgress?: GoalProgressMap;
}

/**
 * Orchestrates one full agent turn. Deliberately non-streaming to the
 * client: the candidate reply is fully generated server-side, THEN checked
 * by the rule judge, THEN (only if it passes, or after a safe regeneration)
 * sent on. There's no way to retract tokens already streamed to the
 * visitor, so streaming and pre-send hard-rule enforcement are in tension —
 * this engine picks enforcement correctness over streaming UX for Phase 1.
 * A provisional-stream-then-reconcile approach is a plausible future
 * optimization, not a Phase 1 requirement.
 */
@Injectable()
export class ConversationEngineService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly sessions: ConversationSessionStore,
    private readonly ruleEnforcer: RuleEnforcerService,
    private readonly fieldExtractor: FieldExtractorService,
    private readonly conversations: ConversationsService,
    private readonly agentLoop: AgentLoopService,
  ) {}

  async handleUserMessage(params: {
    conversationId: string;
    tenantId: string;
    config: AgentPromptConfig;
    userText: string;
    /** Set by the playground / scenario runner; absent for real visitors. */
    simulation?: SimulationHooks;
  }): Promise<TurnResult> {
    // Every model call in this turn — reply, judge, extraction — routes to the tenant's own key/model when they set one.
    return runWithModelContext(params.simulation?.modelContext ?? { tenantId: params.tenantId, agentModels: params.config.spec?.models }, () => this.handleTurn(params));
  }

  private async handleTurn(params: {
    conversationId: string;
    tenantId: string;
    config: AgentPromptConfig;
    userText: string;
    simulation?: SimulationHooks;
  }): Promise<TurnResult> {
    // Agentic agents run the tool-using loop; everything else keeps the original single-completion turn.
    if (params.config.spec?.runtime.mode === "agentic") {
      return this.agentLoop.runTurn(params);
    }
    const userMessage: LlmMessage = { role: "user", content: params.userText };
    let state = await this.sessions.appendMessages(params.conversationId, [userMessage]);

    const chatMessages = buildChatMessages({
      config: params.config,
      capturedDataSoFar: state.capturedData,
      history: state.history,
    });

    const { text: candidateText } = await this.llm.complete({
      purpose: "chat",
      messages: chatMessages,
    });

    const { finalText, violations } = await this.ruleEnforcer.enforce({
      candidateText,
      hardRules: params.config.hardRules,
      messagesForRetry: chatMessages,
      regenerate: async (messages) => (await this.llm.complete({ purpose: "chat", messages })).text,
    });
    if (violations.length > 0) {
      await (params.simulation ? params.simulation.sink.appendViolations(violations) : this.conversations.appendViolations(params.conversationId, violations));
    }

    const { visibleText, outcomeType: rawOutcomeType } = stripCompletionMarker(finalText);
    const outcomeParse = OutcomeTypeSchema.safeParse(rawOutcomeType);
    const outcomeType = outcomeParse.success ? outcomeParse.data : undefined;

    await this.sessions.appendMessages(params.conversationId, [
      { role: "assistant", content: visibleText },
    ]);

    const capturedData = await this.fieldExtractor.extractAndMerge({
      fields: params.config.requiredFields,
      latestUserMessage: params.userText,
      capturedDataSoFar: state.capturedData,
    });
    await this.sessions.setCapturedData(params.conversationId, capturedData);

    return {
      visibleText,
      outcomeType,
      isComplete: outcomeType !== undefined,
      capturedData,
    };
  }

  async getHistory(conversationId: string): Promise<LlmMessage[]> {
    const state = await this.sessions.get(conversationId);
    return state?.history ?? [];
  }
}
