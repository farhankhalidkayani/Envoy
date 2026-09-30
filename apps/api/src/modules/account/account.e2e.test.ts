import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";
import { RetentionService } from "./retention.service.js";

async function json<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

describe("account export + self-delete (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let tenantName: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    tenantName = `Account Test ${suffix}`;
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName, email: `account-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    await prisma.user.update({
      where: { id: reg.user.id },
      data: { featureAccess: { conversations: true, forms: true, recordings: true, export: true, voice: false } },
    });

    await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Export Test Form" }),
    });

  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await app.close();
  }, 15000);

  it("exports tenant data as a JSON attachment, with forms included and no OAuth secrets", async () => {
    const res = await fetch(`${baseUrl}/account/export`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("envoy-data-export.json");
    const body = await json<{
      tenant: { name: string };
      forms: { name: string }[];
      crmConnections: unknown[];
    }>(res);
    expect(body.tenant.name).toBe(tenantName);
    expect(body.forms.some((f) => f.name === "Export Test Form")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("oauthTokens");
  });

  it("rejects a staff (non-owner) user from account routes", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    await prisma.user.create({
      data: {
        tenantId,
        email: `staff-${suffix}@test.dev`,
        passwordHash: await bcrypt.hash("hunter22", 10),
        role: "staff",
      },
    });
    const staffLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `staff-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string }>(r));

    const res = await fetch(`${baseUrl}/account/export`, {
      headers: { Authorization: `Bearer ${staffLogin.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects self-delete with the wrong confirmation name", async () => {
    const res = await fetch(`${baseUrl}/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmName: "not the right name" }),
    });
    expect(res.status).toBe(400);
    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).not.toBeNull();
  });

  it("hard-deletes the tenant and cascades to its data on the correct confirmation", async () => {
    const res = await fetch(`${baseUrl}/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmName: tenantName }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).toBeNull();
    expect(await prisma.form.findFirst({ where: { tenantId } })).toBeNull();
  });
});

describe("admin hard-delete tenant (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let ownerToken: string;
  let adminToken: string;
  let tenantId: string;
  let tenantName: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    tenantName = `Admin Hard Delete ${suffix}`;
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName, email: `hd-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => json<{ accessToken: string; user: { tenantId: string } }>(r));
    ownerToken = reg.accessToken;
    tenantId = reg.user.tenantId;

    const admin = await fetch(`${baseUrl}/auth/register-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `hd-admin-${suffix}@test.dev`,
        password: "hunter22",
        bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
      }),
    }).then((r) => json<{ accessToken: string }>(r));
    adminToken = admin.accessToken;
    void ownerToken;
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await app.close();
  }, 15000);

  it("rejects hard-delete with the wrong confirmation name", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants/${tenantId}/hard`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ confirmName: "wrong" }),
    });
    expect(res.status).toBe(400);
  });

  it("hard-deletes and writes an audit log entry that survives with tenantId nulled", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants/${tenantId}/hard`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ confirmName: tenantName }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "tenant.hard_deleted", meta: { path: ["name"], equals: tenantName } },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.tenantId).toBeNull();
  });
});

describe("retention sweep (unit-ish, via the real service against local Postgres)", () => {
  it("deletes completed/abandoned conversations and submissions past the cutoff, leaves in_progress and recent ones alone", async () => {
    process.env.RETENTION_DAYS = "30";
    const service = new RetentionService(new (await import("../core/prisma/prisma.service.js")).PrismaService());

    const suffix = Math.random().toString(36).slice(2, 8);
    const tenant = await prisma.tenant.create({ data: { name: `Retention Test ${suffix}` } });
    const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: "Retention Bot" } });

    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    const oldCompleted = await prisma.conversation.create({
      data: { agentId: agent.id, tenantId: tenant.id, status: "completed", createdAt: old },
    });
    const oldInProgress = await prisma.conversation.create({
      data: { agentId: agent.id, tenantId: tenant.id, status: "in_progress", createdAt: old },
    });
    const recentCompleted = await prisma.conversation.create({
      data: { agentId: agent.id, tenantId: tenant.id, status: "completed", createdAt: recent },
    });

    const result = await service.sweep();
    expect(result).not.toHaveProperty("skipped");

    expect(await prisma.conversation.findUnique({ where: { id: oldCompleted.id } })).toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: oldInProgress.id } })).not.toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: recentCompleted.id } })).not.toBeNull();

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
    delete process.env.RETENTION_DAYS;
  });

  it("is a no-op when RETENTION_DAYS isn't set", async () => {
    delete process.env.RETENTION_DAYS;
    const service = new RetentionService(new (await import("../core/prisma/prisma.service.js")).PrismaService());
    expect(await service.sweep()).toEqual({ skipped: true });
  });
});
