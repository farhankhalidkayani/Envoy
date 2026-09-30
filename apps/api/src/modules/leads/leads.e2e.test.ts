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

describe("unified leads feed (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let agentId: string;
  let formId: string;
  let publicToken: string;

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
      body: JSON.stringify({ tenantName: `Leads Test ${suffix}`, email: `leads-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    await prisma.user.update({
      where: { id: reg.user.id },
      data: { featureAccess: { conversations: true, forms: true, recordings: true, export: true, voice: false } },
    });

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Leads Test Bot", requiredFields: [{ key: "email", label: "Email", type: "email", required: true }] }),
    }).then((r) => json<{ id: string; publicToken: string }>(r));
    agentId = agent.id;

    // A completed conversation (counts as a lead) and an in-progress one (must not).
    await prisma.conversation.create({
      data: { agentId, tenantId, status: "completed", capturedData: { email: "lead@example.com" }, createdAt: new Date(Date.now() - 1000) },
    });
    await prisma.conversation.create({ data: { agentId, tenantId, status: "in_progress" } });

    const form = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Leads Test Form" }),
    }).then((r) => json<{ id: string; publicToken: string }>(r));
    formId = form.id;
    publicToken = form.publicToken;

    await fetch(`${baseUrl}/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        status: "live",
        schema: {
          steps: [{ id: "s1", fields: [{ id: "f1", key: "email", type: "email", label: "Email", required: true }] }],
          submitLabel: "Send",
          successMessage: "Thanks!",
        },
      }),
    });
    await fetch(`${baseUrl}/public/forms/${publicToken}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "submission@example.com" }),
    });
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  }, 15000);

  it("merges completed conversations and form submissions, newest first, excludes in-progress conversations", async () => {
    const body = await fetch(`${baseUrl}/leads`, { headers: { Authorization: `Bearer ${token}` } }).then((r) =>
      json<{ leads: Array<{ source: string; sourceLabel: string; data: Record<string, unknown>; createdAt: string }>; hasMore: boolean }>(r),
    );
    expect(body.leads).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    // Newest first: the form submission was created after the conversation.
    expect(body.leads[0]!.source).toBe("form");
    expect(body.leads[0]!.sourceLabel).toBe("Leads Test Form");
    expect(body.leads[0]!.data.email).toBe("submission@example.com");
    expect(body.leads[1]!.source).toBe("conversation");
    expect(body.leads[1]!.sourceLabel).toBe("Leads Test Bot");
    expect(body.leads[1]!.data.email).toBe("lead@example.com");
  });

  it("reports stats independent of the feed's limit", async () => {
    const stats = await fetch(`${baseUrl}/leads/stats`, { headers: { Authorization: `Bearer ${token}` } }).then((r) =>
      json<{ totalForms: number; liveForms: number; totalSubmissions: number; totalLeadConversations: number }>(r),
    );
    expect(stats).toEqual({ totalForms: 1, liveForms: 1, totalSubmissions: 1, totalLeadConversations: 1 });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/leads`);
    expect(res.status).toBe(401);
  });
});
