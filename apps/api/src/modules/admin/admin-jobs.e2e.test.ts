import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";
import { createPipelineRedisConnection } from "../pipeline/pipeline-connection.js";
import { RETENTION_QUEUE_NAME } from "../account/retention-queue.service.js";

async function json<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Uses the "retention" queue as the deliberately-failing target: unlike
 * crm-push/integrations-push/conversation-summary, RetentionProcessor never
 * starts a real Worker unless RETENTION_DAYS is set (unset in this test
 * env), so this test's own throwaway Worker is the only consumer — no race
 * with the app's own processors on the same queue.
 */
describe("admin failed-jobs list + retry (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminToken: string;
  let queue: Queue;
  let jobId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const admin = await fetch(`${baseUrl}/auth/register-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `jobs-admin-${suffix}@test.dev`,
        password: "hunter22",
        bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
      }),
    }).then((r) => json<{ accessToken: string }>(r));
    adminToken = admin.accessToken;

    queue = new Queue(RETENTION_QUEUE_NAME, { connection: createPipelineRedisConnection() });
    const failingWorker = new Worker(
      RETENTION_QUEUE_NAME,
      async () => {
        throw new Error("deliberate test failure");
      },
      { connection: createPipelineRedisConnection() },
    );
    const job = await queue.add("test-sweep", {}, { attempts: 1 });
    jobId = job.id!;
    await new Promise<void>((resolve) => failingWorker.on("failed", () => resolve()));
    await failingWorker.close();
  }, 20000);

  afterAll(async () => {
    await queue.getJob(jobId).then((j) => j?.remove());
    await queue.close();
    await app.close();
  }, 15000);

  it("lists the failed job across queues", async () => {
    const jobs = await fetch(`${baseUrl}/admin/jobs/failed`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((r) =>
      json<Array<{ queue: string; id: string; failedReason: string; attemptsMade: number }>>(r),
    );
    const found = jobs.find((j) => j.queue === RETENTION_QUEUE_NAME && j.id === jobId);
    expect(found).toBeDefined();
    expect(found!.failedReason).toContain("deliberate test failure");
    expect(found!.attemptsMade).toBe(1);
  });

  it("rejects a non-admin from the failed-jobs list", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: "Not Admin Co", email: `notadmin-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string }>(r));
    const res = await fetch(`${baseUrl}/admin/jobs/failed`, { headers: { Authorization: `Bearer ${reg.accessToken}` } });
    expect(res.status).toBe(403);
  });

  it("retries the failed job, moving it out of the failed set", async () => {
    const res = await fetch(`${baseUrl}/admin/jobs/${RETENTION_QUEUE_NAME}/${jobId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(201); // Nest's default for POST with no @HttpCode override

    const job = await queue.getJob(jobId);
    expect(await job?.isFailed()).toBe(false);
  });

  it("404s retrying a job that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/admin/jobs/${RETENTION_QUEUE_NAME}/does-not-exist/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("404s retrying against an unknown queue name", async () => {
    const res = await fetch(`${baseUrl}/admin/jobs/not-a-real-queue/${jobId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(404);
  });
});
