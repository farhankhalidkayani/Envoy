import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "./pipeline-connection.js";
import { SUMMARY_QUEUE_NAME, type SummaryJobData } from "./types.js";

/**
 * Enqueue-only side of the pipeline. Kept separate from the worker
 * (pipeline.processor.ts) so any process can enqueue without also running
 * a worker loop — e.g. the REST completion endpoint and the WS gateway
 * both just need to enqueue, never process.
 */
@Injectable()
export class PipelineQueueService implements OnModuleDestroy {
  private readonly queue = new Queue<SummaryJobData>(SUMMARY_QUEUE_NAME, {
    connection: createPipelineRedisConnection(),
  });

  async enqueueSummary(data: SummaryJobData): Promise<void> {
    await this.queue.add("summarize", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
