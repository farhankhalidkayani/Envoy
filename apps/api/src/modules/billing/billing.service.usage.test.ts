import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";

const ORIGINAL_ENV = { ...process.env };

const calls: Array<{ method: string; args: unknown[] }> = [];
let invoiceCounter = 0;

vi.mock("stripe", () => {
  class FakeStripe {
    invoiceItems = {
      create: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "invoiceItems.create", args });
        return { id: `ii_${++invoiceCounter}` };
      }),
    };
  }
  return { default: FakeStripe };
});

const { BillingService } = await import("./billing.service.js");

describe("BillingService usage + overage", () => {
  const billing = new BillingService(new PrismaService());
  let tenantId: string;
  let agentId: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `Usage Test ${Math.random().toString(36).slice(2, 8)}` } });
    tenantId = tenant.id;
    await billing.ensureSubscription(tenantId);
    await prisma.subscription.update({ where: { tenantId }, data: { includedConversations: 2, usageRate: 50 } });
    const agent = await prisma.agent.create({ data: { tenantId, name: "Usage Agent" } });
    agentId = agent.id;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    calls.length = 0;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  async function completeConversation(completedAt: Date) {
    await prisma.conversation.create({
      data: { agentId, tenantId, channel: "chat", status: "completed", completedAt },
    });
  }

  it("counts only completed conversations inside the current cycle, ignoring in-progress/abandoned and other cycles", async () => {
    const now = new Date();
    await completeConversation(now); // this cycle
    await completeConversation(now); // this cycle
    await completeConversation(new Date(now.getTime() - 400 * 24 * 60 * 60_000)); // over a year ago — different cycle
    await prisma.conversation.create({ data: { agentId, tenantId, channel: "chat", status: "in_progress" } });
    await prisma.conversation.create({ data: { agentId, tenantId, channel: "chat", status: "abandoned" } });

    const usage = await billing.getUsage(tenantId);
    expect(usage.usedConversations).toBe(2);
    expect(usage.includedConversations).toBe(2);
    expect(usage.overageConversations).toBe(0);
    expect(usage.overageAmountCents).toBe(0);
  });

  it("computes overage once usage exceeds the included allotment", async () => {
    await completeConversation(new Date());
    await completeConversation(new Date());
    const usage = await billing.getUsage(tenantId);
    expect(usage.usedConversations).toBe(4);
    expect(usage.overageConversations).toBe(2);
    expect(usage.overageAmountCents).toBe(100); // 2 * 50c
  });

  it("mock mode: no Stripe key -> never charges", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await billing.chargeOverage(tenantId)).toEqual({ mode: "mock", charged: false });
    expect(calls).toEqual([]);
  });

  it("real Stripe but tenant never checked out (local_ customer) -> not charged", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const result = await billing.chargeOverage(tenantId);
    expect(result).toEqual({ mode: "stripe", charged: false });
    expect(calls).toEqual([]);
  });

  it("charges the overage once a real customer exists, then is a no-op for the same cycle (idempotent)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    await prisma.subscription.update({ where: { tenantId }, data: { stripeCustomerId: "cus_real123" } });

    const first = await billing.chargeOverage(tenantId);
    expect(first).toEqual({ mode: "stripe", charged: true, amountCents: 100 });
    expect(calls.filter((c) => c.method === "invoiceItems.create")).toHaveLength(1);
    expect(calls[0]!.args[0]).toMatchObject({ customer: "cus_real123", amount: 100, currency: "usd" });

    const second = await billing.chargeOverage(tenantId);
    expect(second).toEqual({ mode: "stripe", charged: false });
    expect(calls.filter((c) => c.method === "invoiceItems.create")).toHaveLength(1); // still just one
  });
});
