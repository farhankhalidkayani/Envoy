import { createServer, type Server as NodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";

/**
 * End-to-end proof of the new field types (multiselect/file/hidden/content)
 * through submission, storage, and the webhook push — the whole reason
 * "hidden" and "file" exist is to reach a CRM/webhook, so this exercises the
 * full path, not just packages/types' unit tests. Also proves
 * sanitizeCapturedData actually runs on the real push path: a file field's
 * data: URL must never leave our server as-is (see core/common's
 * sanitize-captured-data.ts).
 */
describe("form submission (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  let tenantId: string;
  let publicToken: string;
  let formId: string;
  let hookServer: NodeHttpServer;
  let hookUrl: string;
  let receivedBodies: Record<string, unknown>[];

  async function json<T = unknown>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  beforeAll(async () => {
    // safeFetch blocks loopback URLs (SSRF guard) — the test's own capture
    // server is loopback, so this is the same escape hatch an operator
    // would flip for a local/staging deploy.
    process.env.ALLOW_PRIVATE_FETCH = "true";

    receivedBodies = [];
    hookServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedBodies.push(JSON.parse(body || "{}"));
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
    const hookPort = (hookServer.address() as AddressInfo).port;
    hookUrl = `http://127.0.0.1:${hookPort}/hook`;

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
        tenantName: `Forms Test ${suffix}`,
        email: `forms-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => json<{ accessToken: string; user: { id: string; tenantId: string } }>(r));
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    await prisma.user.update({
      where: { id: reg.user.id },
      data: {
        featureAccess: { conversations: true, forms: true, integrations: true, recordings: true, export: true, voice: false },
      },
    });

    const form = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Job Application" }),
    }).then((r) => json<{ id: string; publicToken: string }>(r));
    formId = form.id;
    publicToken = form.publicToken;

    const schema = {
      steps: [
        {
          id: "s1",
          fields: [
            { id: "f1", key: "fullName", type: "text", label: "Full name", required: true },
            {
              id: "f2",
              key: "interests",
              type: "multiselect",
              label: "Interests",
              required: true,
              options: [
                { label: "Sales", value: "sales" },
                { label: "Support", value: "support" },
              ],
            },
            { id: "f3", key: "resume", type: "file", label: "Resume", required: false, fileAccept: "image/*", fileMaxSizeKb: 200 },
            {
              id: "f4",
              key: "utm_source",
              type: "hidden",
              label: "UTM source",
              required: false,
              hiddenSource: { queryParam: "utm_source", defaultValue: "direct" },
            },
            { id: "f5", key: "note", type: "content", label: "Note", content: "Thanks for applying!" },
          ],
        },
      ],
      submitLabel: "Apply",
      successMessage: "Thanks — we'll be in touch.",
    };

    await fetch(`${baseUrl}/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "live", schema }),
    });

    await fetch(`${baseUrl}/integrations/webhook/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: hookUrl, method: "POST" }),
    });
  }, 20000);

  afterAll(async () => {
    delete process.env.ALLOW_PRIVATE_FETCH;
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await app.close();
    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  }, 15000);

  it("serves the public schema without the content block's server-only fields exposed as secrets", async () => {
    const res = await fetch(`${baseUrl}/public/forms/${publicToken}`);
    const body = await json<{ schema: { steps: { fields: { key: string }[] }[] } }>(res);
    const keys = body.schema.steps[0]!.fields.map((f) => f.key);
    expect(keys).toEqual(["fullName", "interests", "resume", "utm_source", "note"]);
  });

  it("accepts a submission with multiselect + file + hidden values, skips the content block", async () => {
    const res = await fetch(`${baseUrl}/public/forms/${publicToken}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Jane Doe",
        interests: ["sales", "support"],
        resume: PNG_DATA_URL,
        utm_source: "newsletter",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ successMessage: string }>(res);
    expect(body.successMessage).toBe("Thanks — we'll be in touch.");

    const submission = await prisma.formSubmission.findFirst({ where: { formId }, orderBy: { createdAt: "desc" } });
    const data = submission!.data as Record<string, unknown>;
    expect(data.interests).toEqual(["sales", "support"]);
    expect(data.resume).toBe(PNG_DATA_URL); // stored raw — sanitization only applies at the push boundary
    expect(data.utm_source).toBe("newsletter");
    expect(data.note).toBeUndefined(); // content blocks are display-only, never submitted data
  });

  it("rejects a multiselect value outside the listed options", async () => {
    const res = await fetch(`${baseUrl}/public/forms/${publicToken}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Bad Actor", interests: ["sales", "nope"] }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ errors: Record<string, string> }>(res);
    expect(body.errors.interests).toBe("Choose only from the listed options");
  });

  it("silently accepts (but drops) a submission with the honeypot field filled in", async () => {
    const before = await prisma.formSubmission.count({ where: { formId } });

    const res = await fetch(`${baseUrl}/public/forms/${publicToken}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Bot", interests: ["sales"], _hp: "I am a bot" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ successMessage: string }>(res);
    expect(body.successMessage).toBe("Thanks — we'll be in touch.");

    const after = await prisma.formSubmission.count({ where: { formId } });
    expect(after).toBe(before); // no row created — the bot never sees a difference, but nothing was stored
  });

  it(
    "pushes the submission to the webhook with the file field replaced by a size/type marker, everything else intact",
    async () => {
      const deadline = Date.now() + 8000;
      while (receivedBodies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(receivedBodies.length).toBeGreaterThan(0);
      const payload = receivedBodies[0]!;
      expect(payload.fullName).toBe("Jane Doe");
      expect(payload.interests).toEqual(["sales", "support"]);
      expect(payload.utm_source).toBe("newsletter");
      expect(payload.resume).not.toBe(PNG_DATA_URL);
      expect(payload.resume).toMatch(/^\[file: image\/png, \d+KB — not forwarded\]$/);
    },
    10000,
  );

  it("persists integrationStatus.webhook.pushedAt via the atomic jsonb_set update", async () => {
    const deadline = Date.now() + 8000;
    let submission = await prisma.formSubmission.findFirst({ where: { formId }, orderBy: { createdAt: "desc" } });
    while (!(submission?.integrationStatus as { webhook?: { pushedAt?: string } })?.webhook?.pushedAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      submission = await prisma.formSubmission.findFirst({ where: { formId }, orderBy: { createdAt: "desc" } });
    }
    const status = submission!.integrationStatus as { webhook?: { pushedAt?: string; error?: string } };
    expect(status.webhook?.pushedAt).toBeTruthy();
    expect(status.webhook?.error).toBeUndefined();
  });
});
