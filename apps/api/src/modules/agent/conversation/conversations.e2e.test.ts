import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { AgentGateway } from "../gateway/agent.gateway.js";

/** Cursor pagination and whole-tenant stats for the portal's conversation dashboard. */
describe("conversations list + stats (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let agentId: string;

  async function json<T = unknown>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

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
        tenantName: `Conv Test ${suffix}`,
        email: `conv-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Conv Test Bot" }),
    }).then((r) => json<{ id: string }>(r));
    agentId = agent.id;

    // 5 conversations, 2 completed, at strictly increasing timestamps so
    // cursor-page ordering across separate requests is deterministic.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await prisma.conversation.create({
        data: {
          agentId,
          tenantId,
          channel: "chat",
          status: i < 2 ? "completed" : "in_progress",
          createdAt: new Date(now + i * 1000),
        },
      });
    }
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  }, 15000);

  it("paginates newest-first with a cursor", async () => {
    const page1 = await fetch(`${baseUrl}/conversations?take=2`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: { id: string; createdAt: string }[]; nextCursor?: string }>(r));
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await fetch(`${baseUrl}/conversations?take=2&cursor=${page1.nextCursor}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: { id: string }[]; nextCursor?: string }>(r));
    expect(page2.rows).toHaveLength(2);
    expect(page1.rows.map((r) => r.id)).not.toEqual(page2.rows.map((r) => r.id));

    const page3 = await fetch(`${baseUrl}/conversations?take=2&cursor=${page2.nextCursor}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: { id: string }[]; nextCursor?: string }>(r));
    expect(page3.rows).toHaveLength(1); // 5 total: 2 + 2 + 1
    expect(page3.nextCursor).toBeUndefined();
  });

  it("reports whole-tenant stats independent of pagination", async () => {
    const stats = await fetch(`${baseUrl}/conversations/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ total: number; completed: number }>(r));
    expect(stats).toEqual({ total: 5, completed: 2 });
  });

  it("scopes stats by agentId when given", async () => {
    const otherAgent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Other Bot" }),
    }).then((r) => json<{ id: string }>(r));

    const stats = await fetch(`${baseUrl}/conversations/stats?agentId=${otherAgent.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ total: number; completed: number }>(r));
    expect(stats).toEqual({ total: 0, completed: 0 });
  });
});
