import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

/**
 * End-to-end proof of the CRM push flow, driven against MockCrmProvider
 * (CRM_PROVIDER=mock, apps/api/.env — no HubSpot developer account
 * available here, same posture as Groq/Gemini/Stripe). Covers: mock-mode
 * connect, field mapping, automatic push-on-completion (async, via
 * CrmQueueService), the push status persisted for dashboard visibility, and
 * the manual re-push path surfacing a provider-side failure correctly.
 */
describe("CRM integration (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  let token: string;
  let tenantId: string;
  let agentId: string;
  let publicToken: string;

  // A void- or null-returning Nest handler sends 200 with an EMPTY body
  // (Content-Length: 0), not "null" — res.json() throws on that. Same class
  // of bug @envoy/sdk's client fixes for good; this test needs the same
  // resilience since it hits the API directly, not through the SDK.
  async function json<T = unknown>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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
        tenantName: `CRM Test ${suffix}`,
        email: `crm-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "CRM Test Bot",
        requiredFields: [{ key: "email", label: "Email", type: "email", required: true }],
      }),
    }).then((r) => json<{ id: string; publicToken: string }>(r));
    agentId = agent.id;
    publicToken = agent.publicToken;

    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "live" }),
    });

    // "crm" isn't in DEFAULT_FEATURE_ACCESS — grant it directly for this test's owner.
    await prisma.user.update({
      where: { id: reg.user.id },
      data: { featureAccess: { conversations: true, crm: true, recordings: true, export: true, voice: false } },
    });
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  }, 15000);

  function runConversationToCompletion(userTurns: string[]): Promise<{ conversationCapturedData: unknown }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/agent/${agentId}`);
      let turnIndex = 0;
      const timeout = setTimeout(() => reject(new Error("timed out")), 15000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "session.start", agentId, publicToken }));
      });
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "session.ready" || msg.type === "agent.message") {
          if (turnIndex < userTurns.length) {
            ws.send(JSON.stringify({ type: "user.message", text: userTurns[turnIndex] }));
            turnIndex++;
          }
        } else if (msg.type === "session.completed") {
          clearTimeout(timeout);
          resolve({ conversationCapturedData: msg.capturedData });
          ws.close();
        } else if (msg.type === "error" || msg.type === "locked") {
          clearTimeout(timeout);
          reject(new Error(`gateway said: ${msg.message ?? msg.type}`));
          ws.close();
        }
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error("WS error"));
      });
    });
  }

  async function waitForCondition<T>(
    fetchValue: () => Promise<T>,
    isReady: (value: T) => boolean,
    { timeoutMs = 8000, intervalMs = 200 } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let value = await fetchValue();
    while (!isReady(value) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      value = await fetchValue();
    }
    return value;
  }

  it("is not connected initially", async () => {
    const res = await fetch(`${baseUrl}/crm/connection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await json(res)).toBeFalsy();
  });

  it("connects in mock mode (no HUBSPOT_CLIENT_ID configured)", async () => {
    const result = await fetch(`${baseUrl}/crm/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ mode: string }>(r));
    expect(result.mode).toBe("mock");

    const connection = await fetch(`${baseUrl}/crm/connection`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ provider: string }>(r));
    expect(connection.provider).toBe("hubspot");
  });

  it("sets a field mapping", async () => {
    await fetch(`${baseUrl}/crm/mapping`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: "email_address" }),
    });
    const connection = await fetch(`${baseUrl}/crm/connection`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ fieldMapping: Record<string, string> }>(r));
    expect(connection.fieldMapping.email).toBe("email_address");
  });

  it(
    "auto-pushes to the CRM when a conversation completes",
    async () => {
      // 1 required field needs 2 turns to complete: turn 1 triggers "could
      // you share your email?", turn 2 answers it and triggers completion.
      await runConversationToCompletion(["Hi there", "crm-push-test@example.com"]);

      const conversation = await waitForCondition(
        () => prisma.conversation.findFirst({ where: { agentId }, orderBy: { createdAt: "desc" } }),
        (c) => c?.crmPushedAt != null,
      );
      expect(conversation?.crmPushedAt).not.toBeNull();
      expect(conversation?.crmExternalId).toMatch(/^mock_contact_/);
      expect(conversation?.crmPushError).toBeNull();
    },
    15000,
  );

  it("surfaces a provider-side failure on manual re-push", async () => {
    // MockCrmProvider deliberately fails on this sentinel value — see
    // providers/mock.provider.ts. Exercises the real mapping+push path
    // (not just the queue plumbing) and confirms failures aren't swallowed.
    const failing = await prisma.conversation.create({
      data: {
        agentId,
        tenantId,
        status: "completed",
        capturedData: { email: "FORCE_CRM_FAILURE" },
      },
    });

    const result = await fetch(`${baseUrl}/crm/push/${failing.id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ success: boolean; error?: string }>(r));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Simulated CRM failure");
  });

  it("rejects CRM routes for a tenant without the feature enabled", async () => {
    const reg2 = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: "No CRM Access Co",
        email: `no-crm-${Math.random().toString(36).slice(2, 8)}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { tenantId: string } }>(r));

    const status = await fetch(`${baseUrl}/crm/connection`, {
      headers: { Authorization: `Bearer ${reg2.accessToken}` },
    }).then((r) => r.status);
    expect(status).toBe(403);

    await prisma.tenant.deleteMany({ where: { id: reg2.user.tenantId } });
  });
});
