import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

async function json<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * No dedicated e2e coverage existed for the webhook connect/disconnect
 * routes before this — only exercised indirectly via forms.e2e.test.ts's
 * webhook-push test. Covers the connect/disconnect flow itself plus the
 * audit logging added alongside it.
 */
describe("integrations connect/disconnect (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: `Integrations Test ${suffix}`,
        email: `integrations-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;
    ownerUserId = reg.user.id;

    await prisma.user.update({
      where: { id: reg.user.id },
      data: { featureAccess: { conversations: true, integrations: true, recordings: true, export: true, voice: false } },
    });
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  }, 15000);

  it("connects a webhook integration and logs an audit entry", async () => {
    const res = await fetch(`${baseUrl}/integrations/webhook/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "https://example.com/hook", method: "POST" }),
    });
    expect(res.status).toBe(201);

    const list = await fetch(`${baseUrl}/integrations`, { headers: { Authorization: `Bearer ${token}` } }).then((r) =>
      json<Array<{ type: string; enabled: boolean }>>(r),
    );
    expect(list.some((i) => i.type === "webhook" && i.enabled)).toBe(true);

    const auditRow = await prisma.auditLog.findFirst({ where: { tenantId, action: "integration.webhook.connected" } });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.adminUserId).toBe(ownerUserId);
    expect((auditRow!.meta as { url?: string }).url).toBe("https://example.com/hook");
  });

  it("disconnecting removes it and logs a separate audit entry", async () => {
    const res = await fetch(`${baseUrl}/integrations/webhook`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const list = await fetch(`${baseUrl}/integrations`, { headers: { Authorization: `Bearer ${token}` } }).then((r) =>
      json<Array<{ type: string }>>(r),
    );
    expect(list.some((i) => i.type === "webhook")).toBe(false);

    const auditRow = await prisma.auditLog.findFirst({ where: { tenantId, action: "integration.webhook.disconnected" } });
    expect(auditRow).not.toBeNull();
  });

  it("rejects integration routes for a tenant without the feature enabled", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const reg2 = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: "No Integrations Co", email: `no-int-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string; user: { tenantId: string } }>(r));

    const status = await fetch(`${baseUrl}/integrations`, { headers: { Authorization: `Bearer ${reg2.accessToken}` } }).then(
      (r) => r.status,
    );
    expect(status).toBe(403);

    await prisma.tenant.deleteMany({ where: { id: reg2.user.tenantId } });
  });
});
