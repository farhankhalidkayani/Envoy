import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { EnvoyApi, OPERATOR_UNTRUSTED_NOTICE, createOperatorServer } from "@envoy/mcp";
import { AppModule } from "../../app.module.js";

describe("operator tokens and the operator MCP server (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const tenants: string[] = [];
  const admins: string[] = [];
  let adminJwt: string;

  const call = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  async function newAdmin() {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await fetch(`${baseUrl}/auth/register-admin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `op-admin-${suffix}@test.dev`, password: "hunter22", bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET }) });
    const body = (await res.json()) as { accessToken: string; user: { id: string } };
    admins.push(body.user.id);
    return body;
  }
  async function tenant(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `op-${label}-${suffix}@test.dev`;
    const reg = await json<{ accessToken: string; user: { tenantId: string; id: string } }>(await fetch(`${baseUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantName: `Operator ${label} ${suffix}`, email, password: "hunter22" }) }));
    tenants.push(reg.user.tenantId);
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId, userId: reg.user.id };
  }
  const mint = async (scopes?: string[], jwt = adminJwt) => json<{ id: string; token: string; scopes: string[]; expiresAt: string }>(await call(jwt, "/admin/operator-tokens", { method: "POST", body: { name: "Ops assistant", ...(scopes ? { scopes } : {}) } }));

  async function operatorClient(token: string) {
    const server = createOperatorServer(new EnvoyApi({ baseUrl, token }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ops-ai", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
    adminJwt = (await newAdmin()).accessToken;
  }, 40000);
  // At most five operator tokens may be active platform-wide: each test starts with this run's own tokens revoked.
  beforeEach(async () => {
    if (admins.length) await prisma.operatorToken.updateMany({ where: { revokedAt: null, userId: { in: admins } }, data: { revokedAt: new Date() } });
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: admins } } }); // don't leave test admins behind
    await app.close();
  });

  describe("managing them", () => {
    it("only a signed-in platform admin can create one: read-only for a week by default, secret shown once", async () => {
      const created = await mint();
      expect(created.token).toMatch(/^envoy_op_/);
      expect(created.scopes).toEqual(["admin:read"]);
      expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      const listed = await json<Array<Record<string, unknown>>>(await call(adminJwt, "/admin/operator-tokens"));
      expect(JSON.stringify(listed)).not.toContain(created.token);
      expect((await call(adminJwt, "/admin/operator-tokens", { method: "POST", body: { name: "x", expiresInDays: 90 } })).status).toBe(400);

      const owner = await tenant("notadmin");
      expect((await call(owner.jwt, "/admin/operator-tokens", { method: "POST", body: { name: "x" } })).status).toBe(403);
      expect((await call(created.token, "/admin/operator-tokens", { method: "POST", body: { name: "x" } })).status).toBe(403); // a token can't mint tokens
      expect((await call(created.token, "/admin/operator-tokens")).status).toBe(403);
      expect(await prisma.auditLog.count({ where: { adminUserId: admins[0], action: "operator_token.created" } })).toBeGreaterThan(0);
    }, 90000);
  });

  describe("what a token may do", () => {
    it("reads with admin:read; writes need admin:write", async () => {
      const t = await tenant("scopes");
      const reader = (await mint()).token;
      expect((await call(reader, "/admin/tenants")).status).toBe(200);
      expect((await call(reader, `/admin/tenants/${t.tenantId}`)).status).toBe(200);
      expect((await call(reader, "/admin/tenants/stats")).status).toBe(200);
      expect((await call(reader, "/admin/audit-log")).status).toBe(200);
      const refused = await call(reader, `/admin/tenants/${t.tenantId}/pause`, { method: "PATCH" });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("admin:write");
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).not.toBe("locked");
    }, 90000);

    it("never — whatever the scopes — changes pricing, charges, deletes a tenant, or reaches a workspace's own API", async () => {
      const t = await tenant("never");
      const writer = (await mint(["admin:read", "admin:write"])).token;
      expect((await call(writer, `/admin/tenants/${t.tenantId}/pricing`, { method: "PATCH", body: { currency: "usd", baseMonthlyCents: 0, perConversationCents: 0, includedConversations: 0 } })).status).toBe(403);
      expect((await call(writer, `/admin/tenants/${t.tenantId}/bill-overage`, { method: "POST" })).status).toBe(403);
      expect((await call(writer, `/admin/tenants/${t.tenantId}`, { method: "DELETE" })).status).toBe(403);
      expect((await call(writer, `/admin/tenants/${t.tenantId}/hard`, { method: "DELETE", body: { confirmName: "x" } })).status).toBe(403);
      expect((await call(writer, "/agents")).status).toBe(403);
      expect(await prisma.tenant.findUnique({ where: { id: t.tenantId } })).not.toBeNull();
      const audited = await prisma.auditLog.findMany({ where: { action: "operator_token.request", meta: { path: ["status"], equals: 403 } }, orderBy: { createdAt: "desc" }, take: 10 });
      expect(audited.map((a) => (a.meta as { path: string }).path)).toEqual(expect.arrayContaining([`/admin/tenants/${t.tenantId}/bill-overage`, `/admin/tenants/${t.tenantId}/hard`]));
    }, 90000);

    it("a workspace's API token can't reach the operator API at all", async () => {
      const t = await tenant("wstoken");
      const ws = await json<{ token: string }>(await call(t.jwt, "/tokens", { method: "POST", body: { name: "x", scopes: ["agents:read", "billing:read", "integrations:read"] } }));
      expect((await call(ws.token, "/admin/tenants")).status).toBe(403);
      expect((await call(ws.token, "/admin/operator-tokens")).status).toBe(403);
    }, 60000);

    it("stops working when revoked, when expired, or when its admin is no longer a platform admin", async () => {
      const a = (await mint()).token;
      const b = await mint();
      const c = (await mint()).token;
      expect((await call(adminJwt, `/admin/operator-tokens/${b.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await call(b.token, "/admin/tenants")).status).toBe(401);
      const exp = await prisma.operatorToken.findFirstOrThrow({ where: { last4: c.slice(-4), userId: admins[0] } });
      await prisma.operatorToken.update({ where: { id: exp.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call(c, "/admin/tenants")).status).toBe(401);

      const other = await newAdmin();
      const theirs = (await mint(undefined, other.accessToken)).token;
      expect((await call(theirs, "/admin/tenants")).status).toBe(200);
      await prisma.user.update({ where: { id: other.user.id }, data: { role: "staff" } });
      expect((await call(theirs, "/admin/tenants")).status).toBe(401);
      expect((await call(a, "/admin/tenants")).status).toBe(200);
    }, 120000);

    it("at most five active at once", async () => {
      const admin = await newAdmin();
      for (let i = 0; i < 5; i++) expect((await call(admin.accessToken, "/admin/operator-tokens", { method: "POST", body: { name: `t${i}` } })).status).toBe(201);
      const sixth = await call(admin.accessToken, "/admin/operator-tokens", { method: "POST", body: { name: "t6" } });
      expect(sixth.status).toBe(400);
    }, 90000);
  });

  describe("through the operator MCP server", () => {
    it("an operator's AI looks around, switches a feature, pauses and resumes a tenant — every change audited under the token", async () => {
      const t = await tenant("mcp");
      const run = await operatorClient((await mint(["admin:read", "admin:write"])).token);

      const stats = JSON.parse((await run("platform_stats")).content[0]!.text) as { total: number };
      expect(stats.total).toBeGreaterThan(0);
      const detail = await run("get_tenant", { tenantId: t.tenantId });
      expect(detail.content[0]!.text).toBe(OPERATOR_UNTRUSTED_NOTICE);
      expect(detail.content[1]!.text).toContain(t.tenantId);

      expect((await run("set_user_feature", { tenantId: t.tenantId, userId: t.userId, feature: "voice", enabled: true })).isError).toBeFalsy();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).featureAccess).toMatchObject({ voice: true });

      expect((await run("pause_tenant", { tenantId: t.tenantId })).isError).toBeFalsy();
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("locked");
      expect((await call(t.jwt, "/agents")).status).toBe(423); // the business is locked out, as pausing means
      expect((await run("resume_tenant", { tenantId: t.tenantId })).isError).toBeFalsy();
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).toBe("active");

      await new Promise((r) => setTimeout(r, 1000));
      const byToken = await prisma.auditLog.findMany({ where: { action: "operator_token.request", meta: { path: ["token"], equals: "Ops assistant" } }, orderBy: { createdAt: "desc" }, take: 3 });
      expect(byToken.map((l) => (l.meta as { path: string }).path).sort()).toEqual([`/admin/tenants/${t.tenantId}/pause`, `/admin/tenants/${t.tenantId}/resume`, `/admin/tenants/${t.tenantId}/users/${t.userId}/access`].sort());
    }, 150000);

    it("with a read-only token, the AI is told plainly it can't change anything", async () => {
      const t = await tenant("mcpro");
      const run = await operatorClient((await mint()).token);
      const res = await run("pause_tenant", { tenantId: t.tenantId });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('doesn\'t have the "admin:write" scope');
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).subscriptionStatus).not.toBe("locked");
    }, 90000);
  });
});
