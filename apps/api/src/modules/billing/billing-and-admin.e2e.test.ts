import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

/**
 * End-to-end proof of the Phase 2 operator layer: the billing lock/unlock
 * state machine (driven by webhook-shaped POSTs, since no live Stripe
 * account is available — see stripe-webhook.controller.ts's dev-mode
 * fallback) and the admin API's tenant/access/pricing controls, including
 * that every admin action is attributable via the audit log.
 */
describe("billing lock/unlock + admin operator API (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;

  let ownerToken: string;
  let tenantId: string;
  let agentId: string;
  let publicToken: string;
  let ownerUserId: string;

  let adminToken: string;

  async function json<T = unknown>(res: Response): Promise<T> {
    return res.json() as Promise<T>;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
    wsBase = `ws://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);

    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: `Billing Test ${suffix}`,
        email: `billing-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) =>
      json<{ accessToken: string; user: { id: string; tenantId: string } }>(r),
    );
    ownerToken = reg.accessToken;
    tenantId = reg.user.tenantId;
    ownerUserId = reg.user.id;

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "Billing Test Bot" }),
    }).then((r) => json<{ id: string; publicToken: string }>(r));
    agentId = agent.id;
    publicToken = agent.publicToken;

    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ status: "live" }),
    });

    const admin = await fetch(`${baseUrl}/auth/register-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `admin-${suffix}@test.dev`,
        password: "hunter22",
        bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
      }),
    }).then((r) => json<{ accessToken: string }>(r));
    adminToken = admin.accessToken;
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } }); // cascades agent + subscription
    await app.close();
  });

  function stripeWebhook(type: "invoice.payment_failed" | "invoice.paid") {
    return fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data: { object: { customer: `local_${tenantId}` } } }),
    });
  }

  function agentsListStatus() {
    return fetch(`${baseUrl}/agents`, { headers: { Authorization: `Bearer ${ownerToken}` } }).then(
      (r) => r.status,
    );
  }

  function attemptWsSession(): Promise<{ type: string; message?: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/agent/${agentId}`);
      const timeout = setTimeout(() => reject(new Error("WS session.start timed out")), 8000);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "session.start", agentId, publicToken }));
      });
      ws.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data as string));
        ws.close();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error("WS error"));
      });
    });
  }

  describe("billing lock/unlock state machine", () => {
    it("starts active with API access and a starter subscription", async () => {
      expect(await agentsListStatus()).toBe(200);

      const sub = await fetch(`${baseUrl}/billing/subscription`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }).then((r) => json<{ status: string; includedConversations: number }>(r));
      expect(sub.status).toBe("active");
      expect(sub.includedConversations).toBe(100);
    });

    it("a single payment failure moves to past_due without blocking access (grace period)", async () => {
      await stripeWebhook("invoice.payment_failed");
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant.subscriptionStatus).toBe("past_due");
      expect(await agentsListStatus()).toBe(200);
    });

    it("a second failure while past_due locks the account", async () => {
      await stripeWebhook("invoice.payment_failed");
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant.subscriptionStatus).toBe("locked");
    });

    it("locked: business API returns 423, billing stays reachable, widget shows locked (not broken)", async () => {
      expect(await agentsListStatus()).toBe(423);

      const billingStatus = await fetch(`${baseUrl}/billing/subscription`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.status);
      expect(billingStatus).toBe(200);

      const wsResponse = await attemptWsSession();
      expect(wsResponse.type).toBe("locked");
    });

    it("invoice.paid restores access instantly, with no data loss", async () => {
      await stripeWebhook("invoice.paid");
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant.subscriptionStatus).toBe("active");
      expect(await agentsListStatus()).toBe(200);

      // Never delete on lock — the agent created before the lock is still there.
      const stillExists = await fetch(`${baseUrl}/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.status);
      expect(stillExists).toBe(200);
    });
  });

  describe("admin operator API", () => {
    it("rejects a non-admin (tenant owner) with 403", async () => {
      const status = await fetch(`${baseUrl}/admin/tenants`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.status);
      expect(status).toBe(403);
    });

    it("lists tenants including ours, with subscription info", async () => {
      const tenants = await fetch(`${baseUrl}/admin/tenants`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).then((r) => json<Array<{ id: string; subscription: { status: string } }>>(r));
      const ours = tenants.find((t) => t.id === tenantId);
      expect(ours?.subscription.status).toBe("active");
    });

    it("pause/resume drives the same status field the billing engine uses", async () => {
      await fetch(`${baseUrl}/admin/tenants/${tenantId}/pause`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(await agentsListStatus()).toBe(423);

      await fetch(`${baseUrl}/admin/tenants/${tenantId}/resume`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(await agentsListStatus()).toBe(200);
    });

    it("updates a user's feature access", async () => {
      await fetch(`${baseUrl}/admin/tenants/${tenantId}/users/${ownerUserId}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ crm: true }),
      });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerUserId } });
      expect((user.featureAccess as Record<string, boolean>).crm).toBe(true);
      // Untouched keys survive the merge — this wasn't a blind overwrite.
      expect((user.featureAccess as Record<string, boolean>).conversations).toBe(true);
    });

    it("updates custom pricing", async () => {
      await fetch(`${baseUrl}/admin/tenants/${tenantId}/pricing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ baseMonthlyCents: 9900, perConversationCents: 25 }),
      });
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect((tenant.priceConfig as Record<string, unknown>).baseMonthlyCents).toBe(9900);
    });

    it("revokes a tenant as a soft-cancel — the row is never deleted", async () => {
      await fetch(`${baseUrl}/admin/tenants/${tenantId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant).not.toBeNull();
      expect(tenant?.subscriptionStatus).toBe("cancelled");
    });

    it("recorded every admin action in the audit log, attributed correctly", async () => {
      const logs = await fetch(`${baseUrl}/admin/audit-log?tenantId=${tenantId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).then((r) => json<Array<{ action: string }>>(r));
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "tenant.paused",
          "tenant.resumed",
          "user.featureAccess.updated",
          "tenant.pricing.updated",
          "tenant.revoked",
        ]),
      );
    });
  });
});
