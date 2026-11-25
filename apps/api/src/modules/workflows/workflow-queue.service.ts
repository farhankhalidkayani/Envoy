import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";

export const WORKFLOW_QUEUE_NAME = "workflow-steps";
export interface WorkflowJob {
  runId: string;
}

/** One delayed job per wake-up of a run: "continue this lead's workflow, N ms from now". The run's own row is the source of truth. */
@Injectable()
export class WorkflowQueueService implements OnModuleDestroy {
  private readonly queue = new Queue<WorkflowJob>(WORKFLOW_QUEUE_NAME, { connection: createPipelineRedisConnection() });

  async enqueue(runId: string, delayMs = 0): Promise<void> {
    await this.queue.add("advance", { runId }, { delay: Math.max(0, Math.round(delayMs)), attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true, removeOnFail: 1000 });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
