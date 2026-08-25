import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { LLM_PROVIDER } from "../agent/providers/llm/llm-provider.module.js";
import type { LlmProvider } from "../agent/providers/llm/types.js";
import { createPipelineRedisConnection } from "./pipeline-connection.js";
import { assembleTranscript } from "./transcript.js";
import { SUMMARY_QUEUE_NAME, type SummaryJobData } from "./types.js";

const SUMMARY_INSTRUCTIONS = [
  "Summarize this customer-support conversation transcript in 2-3 sentences:",
  "the visitor's intent, the key details they shared, and the outcome.",
].join(" ");

/**
 * The async half of the completion flow: runs OUTSIDE the request that
 * marked a conversation complete (see ConversationsService.complete),
 * exactly per the build plan — completion must never block on an LLM
 * summarization call. Assembles the transcript, generates the summary, and
 * persists both.
 */
@Injectable()
export class PipelineProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineProcessor.name);
  private worker?: Worker<SummaryJobData>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  onModuleInit() {
    this.worker = new Worker<SummaryJobData>(
      SUMMARY_QUEUE_NAME,
      (job) => this.process(job),
      { connection: createPipelineRedisConnection() },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`summary job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<SummaryJobData>): Promise<void> {
    const { conversationId, messages } = job.data;
    const transcriptText = assembleTranscript(messages);

    const { text: aiSummary } = await this.llm.complete({
      purpose: "summarize",
      messages: [
        { role: "system", content: SUMMARY_INSTRUCTIONS },
        { role: "user", content: transcriptText || "(empty conversation)" },
      ],
      maxTokens: 200,
    });

    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: { transcriptText, aiSummary },
    });
  }
}
