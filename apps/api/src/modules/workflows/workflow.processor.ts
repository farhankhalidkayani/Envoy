import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { RedisService } from "../core/redis/redis.service.js";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { WorkflowEngine } from "./workflow-engine.service.js";
import { WORKFLOW_QUEUE_NAME, WorkflowQueueService, type WorkflowJob } from "./workflow-queue.service.js";

const LOCK_SECONDS = 120;
const OVERDUE_MS = 5 * 60_000;

@Injectable()
export class WorkflowProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowProcessor.name);
  private worker?: Worker<WorkflowJob>;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly queue: WorkflowQueueService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.worker = new Worker<WorkflowJob>(WORKFLOW_QUEUE_NAME, (job) => this.process(job), { connection: createPipelineRedisConnection(), concurrency: 5 });
    this.worker.on("failed", (job, err) => this.logger.warn(`workflow job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
    this.sweeper = setInterval(() => void this.sweep().catch((e: Error) => this.logger.warn(`sweep failed: ${e.message}`)), Number(process.env.WORKFLOW_SWEEP_MS ?? 300_000));
    this.sweeper.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    await this.worker?.close();
  }

  /** At most one worker advances a given lead at a time, so a sweep and a scheduled wake-up can never both send. */
  async process(job: Job<WorkflowJob>): Promise<void> {
    const { runId } = job.data;
    const lockKey = `workflow:lock:${runId}`;
    if (!(await this.redis.client.set(lockKey, "1", "EX", LOCK_SECONDS, "NX"))) return;
    try {
      const result = await this.engine.advance(runId, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
      if ("wakeInMs" in result) await this.queue.enqueue(runId, result.wakeInMs);
    } finally {
      await this.redis.client.del(lockKey);
    }
  }

  /**
   * Safety net: if Redis lost a delayed job (a flush, a failover), a run would sit "running" forever. Any run that is
   * overdue — its wake-up time has passed by several minutes, or it never got one — is woken again. Waking is
   * idempotent: the engine resumes from the run's own saved step and never repeats a recorded send.
   */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - OVERDUE_MS);
    const stuck = await this.prisma.client.workflowRun.findMany({
      where: { status: "running", OR: [{ nextRunAt: { lt: cutoff } }, { nextRunAt: null, createdAt: { lt: cutoff } }] },
      select: { id: true },
      take: 200,
    });
    for (const run of stuck) await this.queue.enqueue(run.id, 0);
    return stuck.length;
  }
}
