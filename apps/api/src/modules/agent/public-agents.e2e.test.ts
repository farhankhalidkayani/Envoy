import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "./gateway/agent.gateway.js";

/** Only a published lead form's token may ever reach an unauthenticated visitor. */
describe("public agent endpoint: leadFormToken (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let agentId: string;
  let publicToken: string;
  let formId: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const email = `pubagent-${Date.now()}@test.dev`;
    const reg = (await (
      await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantName: "Public Agent Test", email, password: "password123!" }),
      })
    ).json()) as { accessToken: string; user: { tenantId: string } };
    token = reg.accessToken;
    tenantIds.push(reg.user.tenantId);
    await prisma.user.update({ where: { email }, data: { featureAccess: { forms: true, conversations: true } } });

    const agent = (await (
      await fetch(`${baseUrl}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Test Agent" }),
      })
    ).json()) as { id: string; publicToken: string };
    agentId = agent.id;
    publicToken = agent.publicToken;
    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "live" }),
    });

    const form = (await (
      await fetch(`${baseUrl}/forms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Widget lead form" }),
      })
    ).json()) as { id: string };
    formId = form.id;
    await fetch(`${baseUrl}/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schema: { steps: [{ id: "s1", fields: [{ id: "f1", key: "email", type: "email", label: "Email", required: true }] }] } }),
    });
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await app.close();
  });

  async function linkForm() {
    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadFormId: formId }),
    });
  }

  async function publicAgent() {
    return (await fetch(`${baseUrl}/agents/public/${publicToken}`)).json() as Promise<{ leadFormToken: string | null }>;
  }

  it("no linked form -> leadFormToken is null", async () => {
    expect((await publicAgent()).leadFormToken).toBeNull();
  });

  it("linked but still a draft -> leadFormToken stays null (never leaks a draft's token)", async () => {
    await linkForm();
    expect((await publicAgent()).leadFormToken).toBeNull();
  });

  it("linked and published -> leadFormToken is the form's real public token", async () => {
    await fetch(`${baseUrl}/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "live" }),
    });
    const body = await publicAgent();
    const formRes = await fetch(`${baseUrl}/forms/${formId}`, { headers: { Authorization: `Bearer ${token}` } });
    const formBody = (await formRes.json()) as { publicToken: string };
    expect(body.leadFormToken).toBe(formBody.publicToken);
  });

  it("unlinking removes it again", async () => {
    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leadFormId: null }),
    });
    expect((await publicAgent()).leadFormToken).toBeNull();
  });
});
