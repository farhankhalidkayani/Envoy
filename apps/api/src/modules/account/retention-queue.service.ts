import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";

export const RETENTION_QUEUE_NAME = "retention";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Schedules the daily sweep via BullMQ's built-in repeatable-job support —
 * no separate cron package needed. A no-op when RETENTION_DAYS isn't set,
 * so an operator who never opts in never gets a job scheduled in Redis at all.
 */
@Injectable()
export class RetentionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly queue = new Queue(RETENTION_QUEUE_NAME, { connection: createPipelineRedisConnection() });

  async onModuleInit() {
    if (!Number(process.env.RETENTION_DAYS)) return;
    // A fixed jobId means re-adding on every boot/deploy is a no-op, not a duplicate schedule.
    await this.queue.add("sweep", {}, { repeat: { every: ONE_DAY_MS }, jobId: "retention-sweep" });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
