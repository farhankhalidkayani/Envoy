import { describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import { prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { MockLlmProvider } from "../agent/providers/llm/mock.provider.js";
import { PipelineProcessor } from "./pipeline.processor.js";
import type { SummaryJobData } from "./types.js";

function fakeJob(conversationId: string, attemptsMade: number, attempts: number): Job<SummaryJobData> {
  return {
    id: "job1",
    data: { conversationId, messages: [] },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<SummaryJobData>;
}

describe("PipelineProcessor.handleFailure (retry exhaustion)", () => {
  it("persists aiSummaryError only once attemptsMade reaches the configured attempts", async () => {
    const processor = new PipelineProcessor(new PrismaService(), new MockLlmProvider());
    const suffix = Math.random().toString(36).slice(2, 8);
    const tenant = await prisma.tenant.create({ data: { name: `Pipeline Fail Test ${suffix}` } });
    const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: "Fail Bot" } });
    const conversation = await prisma.conversation.create({
      data: { agentId: agent.id, tenantId: tenant.id, status: "completed" },
    });

    // Attempt 1 of 3 — still has retries left, must not mark the summary as failed.
    await processor.handleFailure(fakeJob(conversation.id, 1, 3), new Error("rate limited"));
    let row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.aiSummaryError).toBeNull();

    // Attempt 3 of 3 — exhausted, this is the one that should persist.
    await processor.handleFailure(fakeJob(conversation.id, 3, 3), new Error("LLM provider unreachable"));
    row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.aiSummaryError).toBe("LLM provider unreachable");

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it("swallows the write when the conversation no longer exists", async () => {
    const processor = new PipelineProcessor(new PrismaService(), new MockLlmProvider());
    await expect(
      processor.handleFailure(fakeJob("does-not-exist", 3, 3), new Error("boom")),
    ).resolves.toBeUndefined();
  });
});
