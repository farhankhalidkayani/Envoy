import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";

const ORIGINAL_ENV = { ...process.env };

// Stripe's node SDK talks to the real network regardless of a fake key
// (its "Invalid API Key" error IS a real response from Stripe's servers) —
// mock the module itself rather than fetch, so this test never makes an
// outbound call.
const calls: Array<{ method: string; args: unknown[] }> = [];
let customerCounter = 0;

vi.mock("stripe", () => {
  class FakeStripe {
    customers = {
      create: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "customers.create", args });
        return { id: `cus_fake_${++customerCounter}` };
      }),
    };
    checkout = {
      sessions: {
        create: vi.fn(async (...args: unknown[]) => {
          calls.push({ method: "checkout.sessions.create", args });
          return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" };
        }),
      },
    };
    billingPortal = {
      sessions: {
        create: vi.fn(async (...args: unknown[]) => {
          calls.push({ method: "billingPortal.sessions.create", args });
          return { id: "bps_1", url: "https://billing.stripe.com/bps_1" };
        }),
      },
    };
  }
  return { default: FakeStripe };
});

const { BillingService } = await import("./billing.service.js");

describe("BillingService checkout/portal", () => {
  const billing = new BillingService(new PrismaService());
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `Checkout Test ${Math.random().toString(36).slice(2, 8)}` } });
    tenantId = tenant.id;
    await billing.ensureSubscription(tenantId);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    calls.length = 0;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it("returns mock mode when STRIPE_SECRET_KEY is unset — no Stripe client created, nothing to check out", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await billing.createCheckoutSession(tenantId)).toEqual({ mode: "mock" });
    expect(await billing.createPortalSession(tenantId)).toEqual({ mode: "mock" });
    expect(calls).toEqual([]);
  });

  it("creates a real Stripe customer on first checkout, then reuses it, and returns the session URL", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PRICE_ID = "price_123";
    process.env.PORTAL_URL = "https://portal.example";

    const result = await billing.createCheckoutSession(tenantId);
    expect(result).toEqual({ mode: "stripe", url: "https://checkout.stripe.com/cs_1" });

    const created = calls.find((c) => c.method === "customers.create")!;
    const checkoutCall = calls.find((c) => c.method === "checkout.sessions.create")!;
    const newCustomerId = (created ? "cus_fake_1" : undefined) as string;
    expect(checkoutCall.args[0]).toMatchObject({
      customer: newCustomerId,
      mode: "subscription",
      line_items: [{ price: "price_123", quantity: 1 }],
      success_url: "https://portal.example/dashboard/billing?checkout=success",
      cancel_url: "https://portal.example/dashboard/billing?checkout=cancelled",
      client_reference_id: tenantId,
    });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId } });
    expect(sub.stripeCustomerId).toBe(newCustomerId); // swapped from local_<tenantId>

    // Second call (e.g. "Manage billing") must reuse the customer, not create another.
    const portal = await billing.createPortalSession(tenantId);
    expect(portal).toEqual({ mode: "stripe", url: "https://billing.stripe.com/bps_1" });
    expect(calls.filter((c) => c.method === "customers.create")).toHaveLength(1);
    const portalCall = calls.find((c) => c.method === "billingPortal.sessions.create")!;
    expect(portalCall.args[0]).toMatchObject({ customer: newCustomerId, return_url: "https://portal.example/dashboard/billing" });
  });

  it("throws if STRIPE_PRICE_ID is missing while a real key is configured", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    delete process.env.STRIPE_PRICE_ID;
    await expect(billing.createCheckoutSession(tenantId)).rejects.toThrow(/STRIPE_PRICE_ID/);
  });
});
