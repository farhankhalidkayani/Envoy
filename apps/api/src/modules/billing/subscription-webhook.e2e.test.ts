import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

describe("customer.subscription.* webhooks (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tenantId: string;

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_ALLOW_UNSIGNED = "true";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const email = `subwebhook-${Date.now()}@test.dev`;
    const reg = (await (
      await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantName: "Sub Webhook Test", email, password: "password123!" }),
      })
    ).json()) as { user: { tenantId: string } };
    tenantId = reg.user.tenantId;
  }, 20000);

  beforeEach(async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "active" } });
    await prisma.subscription.update({ where: { tenantId }, data: { status: "active" } });
  });

  afterAll(async () => {
    delete process.env.STRIPE_WEBHOOK_ALLOW_UNSIGNED;
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  });

  function webhook(type: string, status?: string) {
    return fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data: { object: { customer: `local_${tenantId}`, status } } }),
    });
  }

  it("customer.subscription.deleted cancels the tenant", async () => {
    const res = await webhook("customer.subscription.deleted");
    expect(res.status).toBe(201);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.subscriptionStatus).toBe("cancelled");
  });

  it("customer.subscription.updated with status=canceled also cancels the tenant", async () => {
    await webhook("customer.subscription.updated", "canceled");
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.subscriptionStatus).toBe("cancelled");
  });

  it("customer.subscription.updated with any other status is a no-op — invoice events own active/past_due/locked", async () => {
    for (const status of ["active", "past_due", "trialing", "unpaid", "incomplete"]) {
      await webhook("customer.subscription.updated", status);
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant.subscriptionStatus).toBe("active"); // unchanged from beforeEach's reset
    }
  });

  it("cancelling twice is idempotent (no error on an already-cancelled tenant)", async () => {
    await webhook("customer.subscription.deleted");
    const res = await webhook("customer.subscription.deleted");
    expect(res.status).toBe(201);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.subscriptionStatus).toBe("cancelled");
  });

  it("a webhook for an unknown customer id doesn't throw", async () => {
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "customer.subscription.deleted", data: { object: { customer: "cus_totally_unknown" } } }),
    });
    expect(res.status).toBe(404); // NotFoundException from findByStripeCustomerId, not a 500
  });
});
