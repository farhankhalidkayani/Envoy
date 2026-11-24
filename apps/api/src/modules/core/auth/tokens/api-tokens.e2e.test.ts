import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../../app.module.js";

describe("API tokens (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `tok-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: `Tokens ${label} ${suffix}`, email, password: "hunter22" }),
    }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId, email };
  }
  const call = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  interface Created { id: string; token: string; last4: string; scopes: string[] }
  async function mint(jwt: string, scopes: string[], extra: Record<string, unknown> = {}) {
    const res = await call(jwt, "/tokens", { method: "POST", body: { name: "Test token", scopes, ...extra } });
    expect(res.status).toBe(201);
    return json<Created>(res);
  }
  const FULL = ["agents:read", "agents:write", "conversations:read", "forms:read", "forms:write", "models:read", "billing:read", "integrations:read"];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 30000);
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("creating and storing", () => {
    it("shows the secret once, stores only its hash, and never lists it again", async () => {
      const t = await register("create");
      const created = await mint(t.jwt, ["agents:read"]);
      expect(created.token).toMatch(/^envoy_sk_[A-Za-z0-9_-]{40,}$/);
      expect(created.last4).toBe(created.token.slice(-4));

      const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.tokenHash).toBe(createHash("sha256").update(created.token).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(created.token);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000); // 90 days by default

      const listed = await json<Array<Record<string, unknown>>>(await call(t.jwt, "/tokens"));
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(created.token);
      expect(Object.keys(listed[0]!)).not.toContain("tokenHash");

      const logs = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: "api_token.created" } });
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(created.token);
    }, 60000);

    it("validates what can be granted", async () => {
      const t = await register("validate");
      for (const body of [{ name: "x", scopes: [] }, { name: "x", scopes: ["models:write"] }, { name: "x", scopes: ["admin:*"] }, { name: "", scopes: ["agents:read"] }, { name: "x", scopes: ["agents:read"], expiresInDays: 1000 }]) {
        expect((await call(t.jwt, "/tokens", { method: "POST", body })).status).toBe(400);
      }
    }, 60000);

    it("is owner-only, and a token can never manage tokens", async () => {
      const t = await register("owner");
      const created = await mint(t.jwt, FULL);
      for (const [method, path, body] of [["GET", "/tokens"], ["POST", "/tokens", { name: "x", scopes: ["agents:read"] }], ["DELETE", `/tokens/${created.id}`]] as const) {
        expect((await call(created.token, path, { method, body })).status).toBe(403);
      }
      await prisma.user.update({ where: { email: t.email }, data: { role: "staff" } });
      const staff = await json<{ accessToken: string }>(await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: t.email, password: "hunter22" }) }));
      expect((await call(staff.accessToken, "/tokens", { method: "POST", body: { name: "x", scopes: ["agents:read"] } })).status).toBe(403);
    }, 80000);

    it("caps active tokens per workspace", async () => {
      const t = await register("cap");
      const user = await prisma.user.findUniqueOrThrow({ where: { email: t.email } });
      await prisma.apiToken.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ tenantId: t.tenantId, userId: user.id, name: `t${i}`, tokenHash: `h${t.tenantId}${i}`, last4: "0000", scopes: ["agents:read"], expiresAt: new Date(Date.now() + 86_400_000) })) });
      expect((await call(t.jwt, "/tokens", { method: "POST", body: { name: "one too many", scopes: ["agents:read"] } })).status).toBe(400);
    }, 60000);
  });

  describe("authentication", () => {
    it("acts as its user, scoped to the tenant, and only within its scopes", async () => {
      const a = await register("scope-a");
      const b = await register("scope-b");
      const readOnly = await mint(a.jwt, ["agents:read"]);
      const writer = await mint(a.jwt, ["agents:read", "agents:write"]);

      expect((await call(readOnly.token, "/agents")).status).toBe(200);
      const denied = await call(readOnly.token, "/agents", { method: "POST", body: { name: "Nope" } });
      expect(denied.status).toBe(403);
      expect((await json<{ message: string }>(denied)).message).toContain('"agents:write"');
      expect((await call(readOnly.token, "/conversations")).status).toBe(403); // a scope it wasn't given

      const made = await call(writer.token, "/agents", { method: "POST", body: { name: "Made by token" } });
      expect(made.status).toBe(201);
      const agent = await json<{ id: string }>(made);
      expect((await json<Array<{ id: string }>>(await call(readOnly.token, "/agents"))).map((x) => x.id)).toEqual([agent.id]);

      // Another workspace's data is still invisible.
      const bAgent = await json<{ id: string }>(await call(b.jwt, "/agents", { method: "POST", body: { name: "B's" } }));
      expect((await call(writer.token, `/agents/${bAgent.id}`)).status).toBe(404);
      expect(await json<unknown[]>(await call((await mint(b.jwt, ["agents:read"])).token, "/agents"))).toHaveLength(1);
    }, 120000);

    it("rejects revoked, expired, unknown and malformed tokens identically", async () => {
      const t = await register("invalid");
      const revoked = await mint(t.jwt, ["agents:read"]);
      expect((await call(revoked.token, "/agents")).status).toBe(200);
      expect((await call(t.jwt, `/tokens/${revoked.id}`, { method: "DELETE" })).status).toBe(200);

      const expired = await mint(t.jwt, ["agents:read"]);
      await prisma.apiToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const bodies = new Set<string>();
      for (const token of [revoked.token, expired.token, "envoy_sk_" + "a".repeat(43), "envoy_sk_"]) {
        const res = await call(token, "/agents");
        expect(res.status).toBe(401);
        bodies.add(await res.text());
      }
      expect(bodies.size).toBe(1); // identical answers: a caller can't tell a revoked token from one that never existed
    }, 100000);

    it("follows the user: a token dies with its owner and honours the workspace lock", async () => {
      const t = await register("follow");
      const token = await mint(t.jwt, ["agents:read"]);
      await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "locked" } });
      expect((await call(token.token, "/agents")).status).toBe(423); // same lock every other caller gets
      await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "active" } });
      expect((await call(token.token, "/agents")).status).toBe(200);
      await prisma.user.delete({ where: { email: t.email } });
      expect((await call(token.token, "/agents")).status).toBe(401);
    }, 100000);

    it("records last use", async () => {
      const t = await register("lastused");
      const token = await mint(t.jwt, ["agents:read"]);
      expect((await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } })).lastUsedAt).toBeNull();
      await call(token.token, "/agents");
      let row = await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } });
      for (let i = 0; i < 20 && !row.lastUsedAt; i++) { await new Promise((r) => setTimeout(r, 200)); row = await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } }); }
      expect(row.lastUsedAt).not.toBeNull();
    }, 60000);

    it("is rate limited per token", async () => {
      const t = await register("rate");
      const token = await mint(t.jwt, ["models:read"]);
      const statuses: number[] = [];
      for (let batch = 0; batch < 5; batch++) {
        statuses.push(...(await Promise.all(Array.from({ length: 26 }, () => call(token.token, "/models/catalog").then((r) => r.status)))));
      }
      expect(statuses.filter((s) => s === 200).length).toBe(120);
      expect(statuses.filter((s) => s === 429).length).toBe(10);
      // A different token (or a person) is unaffected.
      expect((await call(t.jwt, "/models/catalog")).status).toBe(200);
    }, 150000);
  });

  describe("what a token can never do", () => {
    it("is shut out of accounts, the operator console, billing changes, model keys, integrations and tokens", async () => {
      const t = await register("closed");
      const { token } = await mint(t.jwt, FULL);
      // A token inherits its user's feature flags: with CRM/integrations off, even their reads are refused…
      expect((await call(token, "/crm/connection")).status).toBe(403);
      await prisma.user.update({ where: { email: t.email }, data: { featureAccess: { crm: true, integrations: true } } });
      const attempts: Array<[string, string, unknown?]> = [
        ["GET", "/account"], ["GET", "/account/export"], ["DELETE", "/account"],
        ["GET", "/admin/tenants"], ["POST", "/auth/register-admin", { email: "x@y.co", password: "hunter22", bootstrapSecret: "x" }],
        ["POST", "/billing/checkout"], ["POST", "/billing/portal"],
        ["POST", "/models/credentials", { provider: "openai", label: "x", apiKey: "sk-12345678" }], ["PUT", "/models/config", {}],
        ["POST", "/crm/connect"], ["POST", "/integrations/webhook/connect", {}], ["DELETE", "/integrations/webhook"],
        ["GET", "/tokens"],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(token, path, { method, body });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      // Reads that are open still work.
      for (const path of ["/models/status", "/models/usage", "/billing/subscription", "/crm/connection", "/integrations"]) {
        expect((await call(token, path)).status, path).toBe(200);
      }
    }, 150000);

    it("can edit an agent but not its hard rules, publish it, or hand it your CRM or calendar", async () => {
      const t = await register("edits");
      const { token } = await mint(t.jwt, FULL);
      const agent = await json<{ id: string }>(await call(token, "/agents", { method: "POST", body: { name: "Bot", script: "v1" } }));
      const edit = (body: unknown) => call(token, `/agents/${agent.id}`, { method: "PATCH", body });

      expect((await edit({ script: "A better script", spec: { persona: "Warm", runtime: { mode: "agentic" } } })).status).toBe(200);
      expect((await edit({ status: "paused" })).status).toBe(200); // pausing is safe

      for (const [body, expected] of [
        [{ hardRules: [] }, "Hard rules"],
        [{ hardRules: [{ id: "x", text: "y" }] }, "Hard rules"],
        [{ status: "live" }, "Publishing"],
        [{ spec: { tools: [{ name: "book_meeting" }] } }, "CRM or calendar"],
        [{ spec: { tools: [{ name: "lookup_crm_contact", enabled: true }] } }, "CRM or calendar"],
      ] as const) {
        const res = await edit(body);
        expect(res.status, JSON.stringify(body)).toBe(403);
        expect(await res.text()).toContain(expected);
      }
      expect((await call(token, "/agents", { method: "POST", body: { name: "Sneaky", hardRules: [] } })).status).toBe(403);
      // Creating can't publish at all: a status in the body is ignored and the agent starts as a draft.
      const sneaky = await json<{ status: string }>(await call(token, "/agents", { method: "POST", body: { name: "Sneaky", status: "live" } }));
      expect(sneaky.status).toBe("draft");
      expect((await call(token, `/agents/${agent.id}/versions/1/restore`, { method: "POST" })).status).toBe(403);

      const stored = await json<{ status: string; hardRules: unknown[]; script: string }>(await call(t.jwt, `/agents/${agent.id}`));
      expect(stored).toMatchObject({ status: "paused", hardRules: [], script: "A better script" });

      // A person can do all of it with the same agent.
      expect((await call(t.jwt, `/agents/${agent.id}`, { method: "PATCH", body: { status: "live", hardRules: [{ id: "r", text: "Never promise refunds", action: "block", severity: "high" }] } })).status).toBe(200);
    }, 150000);

    it("can re-save an agent whose integration tools a person already enabled, without being able to add new ones", async () => {
      const t = await register("resend");
      const { token } = await mint(t.jwt, FULL);
      const agent = await json<{ id: string }>(await call(t.jwt, "/agents", { method: "POST", body: { name: "Bot", spec: { runtime: { mode: "agentic" }, tools: [{ name: "book_meeting", enabled: true }] } } }));
      const current = await json<{ spec: { tools: unknown[]; persona: string } }>(await call(token, `/agents/${agent.id}`));
      // A read-modify-write that changes only the persona sends the whole spec back, including the enabled tool.
      expect((await call(token, `/agents/${agent.id}`, { method: "PATCH", body: { spec: { ...current.spec, persona: "Friendly" } } })).status).toBe(200);
      expect((await call(token, `/agents/${agent.id}`, { method: "PATCH", body: { spec: { ...current.spec, tools: [...current.spec.tools, { name: "lookup_crm_contact", enabled: true }] } } })).status).toBe(403);
    }, 100000);

    it("can't approve or reject an AI-drafted improvement, even with every scope", async () => {
      const t = await register("approve");
      await prisma.user.update({ where: { email: t.email }, data: { featureAccess: { improvement: true } } });
      const { token } = await mint(t.jwt, FULL);
      const agent = await json<{ id: string }>(await call(t.jwt, "/agents", { method: "POST", body: { name: "Bot" } }));
      const proposal = await prisma.proposal.create({ data: { tenantId: t.tenantId, agentId: agent.id, baseVersion: 1, changes: { script: "x" }, rationale: "r" } });
      for (const action of ["approve", "reject"]) {
        const res = await call(token, `/agents/${agent.id}/improvement/proposals/${proposal.id}/${action}`, { method: "POST", body: {} });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("person");
      }
      expect((await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe("pending");
      // …but the rest of the flow is open to it.
      expect((await call(token, `/agents/${agent.id}/improvement/metrics`)).status).toBe(200);
    }, 100000);
  });

  describe("audit trail", () => {
    it("records every change a token makes — and the ones it was refused — without bodies or secrets", async () => {
      const t = await register("audit");
      const { token, id } = await mint(t.jwt, FULL);
      const agent = await json<{ id: string }>(await call(token, "/agents", { method: "POST", body: { name: "Audited", script: "SECRET-SCRIPT-TEXT" } }));
      await call(token, `/agents/${agent.id}`, { method: "PATCH", body: { script: "more secret text" } });
      await call(token, `/agents/${agent.id}`, { method: "PATCH", body: { hardRules: [] } }); // refused by policy
      await call(token, "/agents"); // a read
      await call(token, "/account", { method: "DELETE" }); // refused outright

      await new Promise((r) => setTimeout(r, 1500));
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: "api_token.request" }, orderBy: { createdAt: "asc" } });
      const summary = logs.map((l) => { const m = l.meta as { method: string; path: string; status: number; tokenId: string }; return `${m.method} ${m.path.replace(agent.id, ":id")} ${m.status}`; });
      expect(summary).toContain("POST /agents 201");
      expect(summary).toContain("PATCH /agents/:id 200");
      expect(summary).toContain("PATCH /agents/:id 403");
      expect(summary).toContain("DELETE /account 403");
      expect(summary.some((s) => s.startsWith("GET"))).toBe(false);
      expect((logs[0]!.meta as { tokenId: string }).tokenId).toBe(id);
      expect(JSON.stringify(logs)).not.toMatch(/SECRET|secret text|envoy_sk_/);
    }, 100000);

    it("revoking is audited", async () => {
      const t = await register("audit-revoke");
      const { id } = await mint(t.jwt, ["agents:read"]);
      await call(t.jwt, `/tokens/${id}`, { method: "DELETE" });
      await call(t.jwt, `/tokens/${id}`, { method: "DELETE" }); // idempotent, logged once
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: "api_token.revoked" } });
      expect(logs).toHaveLength(1);
    }, 60000);
  });
});
