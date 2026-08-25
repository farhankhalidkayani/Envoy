import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { CrmModule } from "../crm/crm.module.js";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { AgentsController } from "./agents.controller.js";
import { AgentsService } from "./agents.service.js";
import { FieldExtractorService } from "./capture/field-extractor.service.js";
import { ConversationEngineService } from "./conversation/conversation-engine.service.js";
import { ConversationSessionStore } from "./conversation/conversation-session.store.js";
import { ConversationsController } from "./conversation/conversations.controller.js";
import { ConversationsService } from "./conversation/conversations.service.js";
import { AgentGateway } from "./gateway/agent.gateway.js";
import { LlmProviderModule } from "./providers/llm/llm-provider.module.js";
import { VoiceProviderModule } from "./providers/voice/voice-provider.module.js";
import { PublicAgentsController } from "./public-agents.controller.js";
import { RuleEnforcerService } from "./rules/rule-enforcer.service.js";

/**
 * Phase 1: the full conversation engine. See conversation-engine.service.ts
 * for the turn orchestration, rules/rule-enforcer.service.ts for the
 * two-layer hard-rule enforcement, and gateway/agent.gateway.ts for the
 * WS protocol surface the widget talks to.
 */
@Module({
  imports: [CoreModule, LlmProviderModule, VoiceProviderModule, PipelineModule, BillingModule, CrmModule],
  controllers: [AgentsController, PublicAgentsController, ConversationsController],
  providers: [
    AgentsService,
    ConversationSessionStore,
    ConversationsService,
    RuleEnforcerService,
    FieldExtractorService,
    ConversationEngineService,
    AgentGateway,
  ],
  exports: [AgentsService],
})
export class AgentModule {}
