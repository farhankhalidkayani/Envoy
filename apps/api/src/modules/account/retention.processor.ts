import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { RETENTION_QUEUE_NAME } from "./retention-queue.service.js";
import { RetentionService } from "./retention.service.js";

@Injectable()
export class RetentionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionProcessor.name);
  private worker?: Worker;

  constructor(private readonly retention: RetentionService) {}

  onModuleInit() {
    if (!Number(process.env.RETENTION_DAYS)) return;
    this.worker = new Worker(RETENTION_QUEUE_NAME, () => this.retention.sweep(), {
      connection: createPipelineRedisConnection(),
    });
    this.worker.on("failed", (job: Job | undefined, err: Error) => {
      this.logger.error(`retention sweep job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
