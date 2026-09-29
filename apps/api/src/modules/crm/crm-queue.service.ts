import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";

export const CRM_PUSH_QUEUE_NAME = "crm-push";

/** Exactly one is set. Kept as optional fields (not a renamed union) so jobs already queued as `{conversationId}` still process after deploy. */
export interface CrmPushJobData {
  conversationId?: string;
  formSubmissionId?: string;
}

/**
 * Enqueue-only side of the auto-push flow — mirrors PipelineQueueService.
 * Pushing to an external CRM is an HTTP call to a third party that can be
 * slow or down; it must never block the request that marks a conversation
 * complete. Reuses the pipeline's Redis connection helper (a plain
 * `new Redis(...)`, not a shared instance) for the same reason documented
 * there: BullMQ's blocking connections shouldn't share with ordinary
 * session-state traffic.
 */
@Injectable()
export class CrmQueueService implements OnModuleDestroy {
  private readonly queue = new Queue<CrmPushJobData>(CRM_PUSH_QUEUE_NAME, {
    connection: createPipelineRedisConnection(),
  });

  async enqueuePush(data: CrmPushJobData): Promise<void> {
    await this.queue.add("push", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
