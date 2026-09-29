import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import type { PushSource } from "./types.js";

export const INTEGRATIONS_PUSH_QUEUE_NAME = "integrations-push";

export type IntegrationsPushJobData = { integrationId: string } & PushSource;

/** Mirrors CrmQueueService — one job per connected integration, never blocks the request that captured the data. */
@Injectable()
export class IntegrationsQueueService implements OnModuleDestroy {
  private readonly queue = new Queue<IntegrationsPushJobData>(INTEGRATIONS_PUSH_QUEUE_NAME, {
    connection: createPipelineRedisConnection(),
  });

  async enqueuePush(data: IntegrationsPushJobData): Promise<void> {
    await this.queue.add("push", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
