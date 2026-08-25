import { Module } from "@nestjs/common";
import { LlmProviderModule } from "../agent/providers/llm/llm-provider.module.js";
import { CoreModule } from "../core/core.module.js";
import { PipelineProcessor } from "./pipeline.processor.js";
import { PipelineQueueService } from "./pipeline-queue.service.js";

/**
 * BullMQ worker that assembles the transcript and generates the AI summary
 * asynchronously after Conversation.complete(), so the completion request
 * never blocks on an LLM call. See pipeline.processor.ts.
 */
@Module({
  imports: [CoreModule, LlmProviderModule],
  providers: [PipelineQueueService, PipelineProcessor],
  exports: [PipelineQueueService],
})
export class PipelineModule {}
