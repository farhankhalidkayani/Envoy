import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { IntegrationsService } from "./integrations.service.js";
import { INTEGRATIONS_PUSH_QUEUE_NAME, type IntegrationsPushJobData } from "./integrations-queue.service.js";

@Injectable()
export class IntegrationsPushProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationsPushProcessor.name);
  private worker?: Worker<IntegrationsPushJobData>;

  constructor(private readonly integrations: IntegrationsService) {}

  onModuleInit() {
    this.worker = new Worker<IntegrationsPushJobData>(
      INTEGRATIONS_PUSH_QUEUE_NAME,
      (job) => this.process(job),
      { connection: createPipelineRedisConnection() },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`Integration push job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<IntegrationsPushJobData>): Promise<void> {
    const { integrationId, ...source } = job.data;
    const result = await this.integrations.push(integrationId, source);
    if (!result.success) {
      throw new Error(result.error ?? "Integration push failed");
    }
  }
}
