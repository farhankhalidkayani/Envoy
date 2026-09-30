import { Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { SUMMARY_QUEUE_NAME } from "../pipeline/types.js";
import { CRM_PUSH_QUEUE_NAME } from "../crm/crm-queue.service.js";
import { INTEGRATIONS_PUSH_QUEUE_NAME } from "../integrations/integrations-queue.service.js";
import { RETENTION_QUEUE_NAME } from "../account/retention-queue.service.js";

const QUEUE_NAMES = [CRM_PUSH_QUEUE_NAME, INTEGRATIONS_PUSH_QUEUE_NAME, SUMMARY_QUEUE_NAME, RETENTION_QUEUE_NAME] as const;

/**
 * Read/retry access to each queue's dead-letter set. BullMQ already keeps
 * every permanently-failed job (none of these queues set removeOnFail, so
 * the default is "keep forever") — this just surfaces what's already there
 * to the operator instead of it being invisible outside worker logs.
 */
@Injectable()
export class AdminJobsService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: createPipelineRedisConnection() })]),
  );

  async listFailed() {
    const perQueue = await Promise.all(
      [...this.queues.entries()].map(async ([queue, q]) => {
        const jobs = await q.getFailed(0, 50);
        return jobs.map((job) => ({
          queue,
          id: job.id!,
          name: job.name,
          data: job.data as Record<string, unknown>,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
        }));
      }),
    );
    return perQueue.flat().sort((a, b) => b.timestamp - a.timestamp);
  }

  async retry(queueName: string, jobId: string) {
    const queue = this.queues.get(queueName);
    if (!queue) throw new NotFoundException("Unknown queue");
    const job = await queue.getJob(jobId);
    if (!job) throw new NotFoundException("Job not found");
    await job.retry();
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
