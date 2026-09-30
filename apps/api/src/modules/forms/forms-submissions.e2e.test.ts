import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

/** Submission management: cursor pagination, CSV export, and delete — all tenant-scoped. */
describe("form submissions management (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let publicToken: string;
  let formId: string;

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
        tenantName: `Submissions Test ${suffix}`,
        email: `submissions-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    await prisma.user.update({
      where: { id: reg.user.id },
      data: { featureAccess: { conversations: true, forms: true, recordings: true, export: true, voice: false } },
    });

    const form = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Contact Us" }),
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
          successMessage: "Got it!",
        },
      }),
    });

    // Seed 5 submissions, sequentially so createdAt ordering is deterministic.
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/public/forms/${publicToken}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `lead${i}@example.com` }),
      });
    }
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
  }, 15000);

  it("paginates with a cursor, oldest page has no nextCursor", async () => {
    const page1 = await fetch(`${baseUrl}/forms/${formId}/submissions?take=2`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: { id: string; data: { email: string } }[]; nextCursor?: string }>(r));
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0]!.data.email).toBe("lead4@example.com"); // newest first
    expect(page1.nextCursor).toBeDefined();

    const page2 = await fetch(`${baseUrl}/forms/${formId}/submissions?take=2&cursor=${page1.nextCursor}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: { id: string; data: { email: string } }[]; nextCursor?: string }>(r));
    expect(page2.rows).toHaveLength(2);
    expect(page2.rows[0]!.data.email).toBe("lead2@example.com");
    expect(page1.rows.map((r) => r.id)).not.toEqual(page2.rows.map((r) => r.id));

    const page3 = await fetch(`${baseUrl}/forms/${formId}/submissions?take=2&cursor=${page2.nextCursor}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => json<{ rows: unknown[]; nextCursor?: string }>(r));
    expect(page3.rows).toHaveLength(1); // 5 total: 2 + 2 + 1
    expect(page3.nextCursor).toBeUndefined();
  });

  it("exports all submissions as CSV with a header row and one row per submission", async () => {
    const res = await fetch(`${baseUrl}/forms/${formId}/submissions/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("submissions.csv");
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Submitted,email");
    expect(lines).toHaveLength(6); // header + 5 submissions
    expect(csv).toContain("lead0@example.com");
    expect(csv).toContain("lead4@example.com");
  });

  it("deletes a submission, tenant-scoped — a foreign tenant can't delete it", async () => {
    const target = await prisma.formSubmission.findFirst({ where: { formId }, orderBy: { createdAt: "asc" } });

    const reg2 = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: "Other Tenant",
        email: `other-${Math.random().toString(36).slice(2, 8)}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { tenantId: string } }>(r));
    await prisma.user.updateMany({
      where: { tenantId: reg2.user.tenantId },
      data: { featureAccess: { conversations: true, forms: true, recordings: true, export: true, voice: false } },
    });

    const foreignAttempt = await fetch(`${baseUrl}/forms/${formId}/submissions/${target!.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${reg2.accessToken}` },
    });
    expect(foreignAttempt.status).toBe(404); // scoped by tenantId in the delete itself — a foreign tenant sees "not found", not "forbidden"
    expect(await prisma.formSubmission.findUnique({ where: { id: target!.id } })).not.toBeNull();
    await prisma.tenant.deleteMany({ where: { id: reg2.user.tenantId } });

    const ownAttempt = await fetch(`${baseUrl}/forms/${formId}/submissions/${target!.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ownAttempt.status).toBe(200);
    expect(await prisma.formSubmission.findUnique({ where: { id: target!.id } })).toBeNull();
  });

  it("404s deleting a submission that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/forms/${formId}/submissions/does-not-exist`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
