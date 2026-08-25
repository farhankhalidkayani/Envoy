import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { CrmService } from "./crm.service.js";
import { CRM_PUSH_QUEUE_NAME, type CrmPushJobData } from "./crm-queue.service.js";

@Injectable()
export class CrmPushProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrmPushProcessor.name);
  private worker?: Worker<CrmPushJobData>;

  constructor(private readonly crm: CrmService) {}

  onModuleInit() {
    this.worker = new Worker<CrmPushJobData>(
      CRM_PUSH_QUEUE_NAME,
      (job) => this.process(job),
      { connection: createPipelineRedisConnection() },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`CRM push job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<CrmPushJobData>): Promise<void> {
    const result = await this.crm.pushConversation(job.data.conversationId);
    if (!result.success) {
      // Throwing lets BullMQ's attempts/backoff retry a transient failure
      // (network blip, rate limit) rather than silently dropping it.
      throw new Error(result.error ?? "CRM push failed");
    }
  }
}
