import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";
import { EMAIL_CHANNEL, SMS_CHANNEL, type EmailChannel, type EmailMessage, type SendOutcome, type SmsChannel } from "./channels.js";
import { contactHash, twilioSignature, verifyUnsubscribeToken } from "./contact.js";
import { WorkflowProcessor } from "./workflow.processor.js";
import { WorkflowsService } from "./workflows.service.js";

class FakeEmail implements EmailChannel {
  sent: EmailMessage[] = [];
  /** Outcomes for the next calls, in order; once empty every send succeeds. */
  script: SendOutcome[] = [];
  async send(m: EmailMessage): Promise<SendOutcome> {
    const next = this.script.shift();
    if (next && !next.ok) return next;
    this.sent.push(m);
    return { ok: true, id: `email_${this.sent.length}` };
  }
}
class FakeSms implements SmsChannel {
  readonly name = "fake";
  sent: Array<{ to: string; body: string }> = [];
  script: SendOutcome[] = [];
  async send(m: { to: string; body: string }): Promise<SendOutcome> {
    const next = this.script.shift();
    if (next && !next.ok) return next;
    this.sent.push(m);
    return { ok: true, id: `sms_${this.sent.length}` };
  }
}

describe("follow-up workflows (e2e)", () => {
  const email = new FakeEmail();
  const sms = new FakeSms();
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  let service: WorkflowsService;
  let processor: WorkflowProcessor;
  const tenants: string[] = [];

  const NO_QUIET = { quietHours: { enabled: false } };
  const hourUtc = () => new Date().getUTCHours();
  /** A quiet window that contains this moment (±1h), and one that does not. */
  const quietNow = () => ({ timezone: "UTC", quietHours: { enabled: true, startHour: (hourUtc() + 23) % 24, endHour: (hourUtc() + 2) % 24 } });
  const quietLater = () => ({ timezone: "UTC", quietHours: { enabled: true, startHour: (hourUtc() + 4) % 24, endHour: (hourUtc() + 6) % 24 } });

  async function register(label: string, flags: Record<string, boolean> = { workflows: true }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const addr = `wf-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantName: `Workflows ${label} ${suffix}`, email: addr, password: "hunter22" }) }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    if (Object.keys(flags).length) await prisma.user.update({ where: { email: addr }, data: { featureAccess: flags } });
    const agent = await prisma.agent.create({ data: { tenantId: reg.user.tenantId, name: "Bot" } });
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId, email: addr, agentId: agent.id };
  }
  const call = (jwt: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  const sendEmail = (over: object = {}) => ({ type: "send_email", subject: "Hi {{name}}", body: "Thanks for getting in touch, {{name}}.", ...over });
  const sendSms = (body = "Hi {{name}}, we'll call you soon.") => ({ type: "send_sms", body });
  const wait = (amount: number, unit = "days") => ({ type: "wait", amount, unit });
  const def = (steps: unknown[], over: Record<string, unknown> = {}) => ({ name: "Follow up", trigger: { type: "conversation_completed" }, steps, settings: NO_QUIET, ...over });

  async function createLive(t: { jwt: string }, body: Record<string, unknown>) {
    const res = await call(t.jwt, "/workflows", { method: "POST", body });
    expect(res.status, await res.clone().text()).toBe(201);
    const wf = await json<{ id: string }>(res);
    expect((await call(t.jwt, `/workflows/${wf.id}/status`, { method: "POST", body: { status: "live" } })).status).toBe(201);
    return wf;
  }
  async function lead(t: { tenantId: string; agentId: string }, data: Record<string, unknown>, outcome: "demo_booking" | null = "demo_booking") {
    return prisma.conversation.create({ data: { tenantId: t.tenantId, agentId: t.agentId, status: "completed", outcomeType: outcome, capturedData: data as object } });
  }
  async function enrolAndSettle(t: { tenantId: string }, conversationId: string, until: (r: { status: string; nextStep: number; nextRunAt: Date | null }) => boolean = (r) => r.status !== "running") {
    expect(await service.enroll(t.tenantId, { conversationId })).toBeGreaterThanOrEqual(0);
    return settle(conversationId, until);
  }
  async function settle(conversationId: string, until: (r: { status: string; nextStep: number; nextRunAt: Date | null }) => boolean) {
    let run = await prisma.workflowRun.findFirst({ where: { sourceId: conversationId }, include: { logs: { orderBy: { stepIndex: "asc" } } } });
    for (let i = 0; i < 80 && (!run || !until(run)); i++) {
      await new Promise((r) => setTimeout(r, 250));
      run = await prisma.workflowRun.findFirst({ where: { sourceId: conversationId }, include: { logs: { orderBy: { stepIndex: "asc" } } } });
    }
    return run!;
  }
  /** Simulates a wait elapsing: the delayed queue job firing. */
  const wake = (runId: string, attemptsMade = 0) => processor.process({ data: { runId }, attemptsMade, opts: { attempts: 3 } } as never);
  const settled = (r: { status: string }) => r.status !== "running";
  const statuses = (r: { logs: Array<{ type: string; status: string }> }) => r.logs.map((l) => `${l.type}:${l.status}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_CHANNEL).useValue(email).overrideProvider(SMS_CHANNEL).useValue(sms).compile();
    app = moduleRef.createNestApplication();
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    wsBase = `ws://localhost:${port}`;
    service = app.get(WorkflowsService);
    processor = app.get(WorkflowProcessor);
  }, 40000);
  beforeEach(() => { email.sent = []; email.script = []; sms.sent = []; sms.script = []; });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("definitions", () => {
    it("is off until the operator enables it, and closed to API tokens", async () => {
      const off = await register("gate", {});
      expect((await call(off.jwt, "/workflows")).status).toBe(403);
      const on = await register("gate-on");
      expect((await call(on.jwt, "/workflows")).status).toBe(200);
      await prisma.user.update({ where: { email: on.email }, data: { featureAccess: { workflows: true } } });
      const tok = await json<{ token: string }>(await call(on.jwt, "/tokens", { method: "POST", body: { name: "t", scopes: ["agents:read", "agents:write"] } }));
      expect((await call(tok.token, "/workflows")).status).toBe(403);
    }, 60000);

    it("validates what can be saved and who owns what it refers to", async () => {
      const t = await register("validate");
      const other = await register("validate-other");
      const post = (body: unknown) => call(t.jwt, "/workflows", { method: "POST", body });
      expect((await post(def([wait(1)]))).status).toBe(400); // nothing to send
      expect((await post(def([wait(40), wait(40), sendSms()]))).status).toBe(400); // 80 days
      expect((await post(def([sendSms()], { settings: { timezone: "Mars/Base" } }))).status).toBe(400);
      expect((await post(def([sendEmail({ to: "nope" })]))).status).toBe(400);
      expect((await post(def([sendSms()], { trigger: { type: "conversation_completed", agentId: other.agentId } }))).status).toBe(400); // someone else's agent
      expect((await post(def([sendSms()], { trigger: { type: "conversation_completed", agentId: t.agentId } }))).status).toBe(201);
    }, 80000);

    it("keeps a live workflow immutable, restricts going live to the owner, and stops leads when paused", async () => {
      const t = await register("lifecycle");
      const wf = await createLive(t, def([sendEmail(), wait(2), sendSms()]));
      const edit = await call(t.jwt, `/workflows/${wf.id}`, { method: "PATCH", body: { name: "Renamed" } });
      expect(edit.status).toBe(409);
      expect(await edit.text()).toContain("Pause");

      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      expect(run.status).toBe("running");

      expect((await call(t.jwt, `/workflows/${wf.id}/status`, { method: "POST", body: { status: "paused" } })).status).toBe(201);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))).toMatchObject({ status: "stopped", stopReason: "workflow_paused" });
      expect((await call(t.jwt, `/workflows/${wf.id}`, { method: "PATCH", body: { name: "Renamed" } })).status).toBe(200); // editable once paused
      expect((await call(t.jwt, `/workflows/${wf.id}/status`, { method: "POST", body: { status: "draft" } })).status).toBe(400);

      // New leads are not enrolled while it's paused.
      const c2 = await lead(t, { name: "Bob", email: "bob@example.com" });
      expect(await service.enroll(t.tenantId, { conversationId: c2.id })).toBe(0);

      await prisma.user.update({ where: { email: t.email }, data: { role: "staff" } });
      const staff = await json<{ accessToken: string }>(await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: t.email, password: "hunter22" }) }));
      const live = await call(staff.accessToken, `/workflows/${wf.id}/status`, { method: "POST", body: { status: "live" } });
      expect(live.status).toBe(403);
      expect((await call(staff.accessToken, "/workflows", { method: "POST", body: def([sendSms()]) })).status).toBe(201); // staff can still draft
    }, 150000);

    it("is tenant-scoped, and deleting a workflow removes its runs", async () => {
      const a = await register("scope-a");
      const b = await register("scope-b");
      const wf = await createLive(a, def([sendEmail()]));
      const c = await lead(a, { name: "Ada", email: "ada@example.com" });
      const run = await enrolAndSettle(a, c.id);
      for (const [method, path] of [["GET", `/workflows/${wf.id}`], ["PATCH", `/workflows/${wf.id}`], ["DELETE", `/workflows/${wf.id}`], ["GET", `/workflows/${wf.id}/runs`], ["GET", `/workflows/runs/${run.id}`], ["POST", `/workflows/runs/${run.id}/cancel`]] as const) {
        expect((await call(b.jwt, path, { method, body: method === "PATCH" ? { name: "x" } : undefined })).status, `${method} ${path}`).toBe(404);
      }
      expect((await call(a.jwt, `/workflows/${wf.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(0);
    }, 120000);
  });

  describe("enrolment and sending", () => {
    it("enrols only qualifying leads, once each, and sends personalised email and SMS with the compliance extras", async () => {
      const t = await register("send");
      const wf = await createLive(t, def([sendEmail({ subject: "Welcome, {{name}}" }), sendSms()], { name: "Hot leads", conditions: { match: "all", conditions: [{ field: "budget", op: "gt", value: 5000 }, { field: "$outcome", op: "equals", value: "demo_booking" }] } }));
      const hot = await lead(t, { name: "Ada", email: "Ada@Example.com", phone: "+44 7700 900123", budget: 8000 });
      const cold = await lead(t, { name: "Bob", email: "bob@example.com", phone: "+14155550100", budget: 100 });
      const wrongOutcome = await lead(t, { name: "Cy", email: "cy@example.com", budget: 9000 }, null);

      expect(await service.enroll(t.tenantId, { conversationId: cold.id })).toBe(0);
      expect(await service.enroll(t.tenantId, { conversationId: wrongOutcome.id })).toBe(0);
      const run = await enrolAndSettle(t, hot.id);
      expect(await service.enroll(t.tenantId, { conversationId: hot.id })).toBe(0); // already in it: never twice
      expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(1);

      expect(run.status).toBe("completed");
      expect(statuses(run)).toEqual(["send_email:sent", "send_sms:sent"]);
      expect(email.sent).toHaveLength(1);
      const mail = email.sent[0]!;
      expect(mail).toMatchObject({ to: "ada@example.com", subject: "Welcome, Ada" });
      expect(mail.text).toContain("Thanks for getting in touch, Ada.");
      expect(mail.text).toMatch(/Sent by Workflows send \w+\./);
      const link = /Unsubscribe: (\S+)/.exec(mail.text)![1]!;
      expect(verifyUnsubscribeToken(link.split("/").pop()!)).toEqual({ tenantId: t.tenantId, email: "ada@example.com" });
      expect(mail.headers).toMatchObject({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(mail.idempotencyKey).toBe(`${run.id}:0`);
      expect(sms.sent).toEqual([{ to: "+447700900123", body: "Hi Ada, we'll call you soon.\nReply STOP to opt out." }]);
      // Logs identify recipients without storing them in the clear.
      expect(run.logs.map((l) => l.toMasked)).toEqual(["a***@example.com", "+44…0123"]);
      expect(JSON.stringify(run.logs)).not.toContain("ada@example.com");
    }, 120000);

    it("waits between steps and picks up where it left off when the wait is over", async () => {
      const t = await register("wait");
      await createLive(t, def([sendEmail({ subject: "One" }), wait(1, "days"), sendSms("Two")]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      expect(run).toMatchObject({ status: "running", nextStep: 2 });
      expect(statuses(run)).toEqual(["send_email:sent", "wait:waiting"]);
      expect(Math.abs((run.nextRunAt!.getTime() - Date.now()) - 86_400_000)).toBeLessThan(60_000);
      expect(sms.sent).toEqual([]); // not before the wait is up

      await wake(run.id);
      const done = await settle(c.id, settled);
      expect(done.status).toBe("completed");
      expect(statuses(done)).toEqual(["send_email:sent", "wait:waiting", "send_sms:sent"]);
      expect(sms.sent.map((m) => m.body)).toEqual(["Two\nReply STOP to opt out."]);
      expect(email.sent).toHaveLength(1);
    }, 120000);

    it("never sends a step twice, even if its job is delivered again", async () => {
      const t = await register("idem");
      await createLive(t, def([sendEmail(), wait(1), sendSms()]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      await wake(run.id);
      await settle(c.id, settled);
      await wake(run.id);
      await wake(run.id); // duplicate deliveries of a finished run
      expect(email.sent).toHaveLength(1);
      expect(sms.sent).toHaveLength(1);
    }, 120000);

    it("full path: a finished conversation enrols the lead automatically", async () => {
      const t = await register("path");
      await createLive(t, def([sendEmail({ subject: "Thanks {{email}}" })]));
      await prisma.agent.update({ where: { id: t.agentId }, data: { status: "live", requiredFields: [{ key: "email", label: "Email", type: "email", required: true }] } });
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: t.agentId } });
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
        const timer = setTimeout(() => reject(new Error("timed out")), 40000);
        let sent = 0;
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data as string) as { type: string };
          if (m.type === "session.ready") ws.send(JSON.stringify({ type: "user.message", text: "Hello" })), sent++;
          else if (m.type === "agent.message" && sent === 1) ws.send(JSON.stringify({ type: "user.message", text: "my email is grace@example.com" })), sent++;
          else if (m.type === "session.completed") { clearTimeout(timer); ws.close(); resolve(); }
        });
      });
      for (let i = 0; i < 60 && email.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]).toMatchObject({ to: "grace@example.com", subject: "Thanks grace@example.com" });
    }, 120000);

    it("a form submission trigger can be limited to one form", async () => {
      const t = await register("form");
      const mine = await prisma.form.create({ data: { tenantId: t.tenantId, name: "Contact", schema: { steps: [] } } });
      const other = await prisma.form.create({ data: { tenantId: t.tenantId, name: "Other", schema: { steps: [] } } });
      await createLive(t, def([sendEmail()], { trigger: { type: "form_submitted", formId: mine.id } }));
      const a = await prisma.formSubmission.create({ data: { tenantId: t.tenantId, formId: mine.id, data: { name: "Ada", email: "ada@example.com" } } });
      const b = await prisma.formSubmission.create({ data: { tenantId: t.tenantId, formId: other.id, data: { name: "Bob", email: "bob@example.com" } } });
      expect(await service.enroll(t.tenantId, { formSubmissionId: b.id })).toBe(0);
      expect(await service.enroll(t.tenantId, { formSubmissionId: a.id })).toBe(1);
      for (let i = 0; i < 40 && email.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      expect(email.sent.map((m) => m.to)).toEqual(["ada@example.com"]);
    }, 100000);
  });

  describe("the gate: when a message must not go out", () => {
    const run1 = async (label: string, settings: object, steps: unknown[], data: Record<string, unknown>, setup?: (t: Awaited<ReturnType<typeof register>>) => Promise<void>) => {
      const t = await register(label);
      await createLive(t, def(steps, { settings: { ...NO_QUIET, ...settings } }));
      await setup?.(t);
      const c = await lead(t, data);
      return { t, c, run: await enrolAndSettle(t, c.id) };
    };

    it("skips, with the reason, a lead with no usable address or number — and carries on", async () => {
      const { run } = await run1("addr", {}, [sendEmail(), sendSms(), sendEmail({ subject: "Last" })], { name: "Ada", email: "not-an-email", phone: "07700 900123" });
      expect(run.status).toBe("completed");
      expect(run.logs.map((l) => [l.status, l.detail])).toEqual([
        ["skipped", "No valid email address in “email”"],
        ["skipped", "No phone number in international format (+…) in “phone”"],
        ["skipped", "No valid email address in “email”"],
      ]);
      expect(email.sent).toEqual([]);
      expect(sms.sent).toEqual([]);
    }, 100000);

    it("texts only leads who clearly consented, when the workflow asks for consent", async () => {
      const settings = { smsConsentField: "sms_ok" };
      const no = await run1("consent-no", settings, [sendSms()], { name: "Ada", phone: "+14155550100", sms_ok: "maybe" });
      expect(no.run.logs[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("No SMS consent") });
      const blank = await run1("consent-blank", settings, [sendSms()], { name: "Ada", phone: "+14155550100" });
      expect(blank.run.logs[0]!.status).toBe("skipped");
      expect(sms.sent).toEqual([]);
      const yes = await run1("consent-yes", settings, [sendSms()], { name: "Ada", phone: "+14155550100", sms_ok: true });
      expect(yes.run.logs[0]!.status).toBe("sent");
    }, 150000);

    it("honours opt-outs per channel, per workspace", async () => {
      const optedOut = (channel: "email" | "sms", address: string) => async (t: { tenantId: string }) => { await prisma.optOut.create({ data: { tenantId: t.tenantId, channel, address, reason: "stop" } }); };
      const e = await run1("oo-email", {}, [sendEmail(), sendSms()], { name: "Ada", email: "ada@example.com", phone: "+14155550100" }, optedOut("email", "ada@example.com"));
      expect(e.run.logs.map((l) => [l.type, l.status, l.detail])).toEqual([["send_email", "skipped", "Lead unsubscribed from email"], ["send_sms", "sent", null]]); // SMS unaffected
      const s = await run1("oo-sms", {}, [sendSms()], { name: "Ada", phone: "+14155550100" }, optedOut("sms", "+14155550100"));
      expect(s.run.logs[0]).toMatchObject({ status: "skipped", detail: "Lead opted out of SMS" });
      // Another workspace's opt-out means nothing here.
      const other = await register("oo-other");
      await prisma.optOut.create({ data: { tenantId: other.tenantId, channel: "email", address: "grace@example.com", reason: "stop" } });
      const g = await run1("oo-scope", {}, [sendEmail()], { name: "Grace", email: "grace@example.com" });
      expect(g.run.logs[0]!.status).toBe("sent");
    }, 200000);

    it("holds a text that would land in quiet hours, and sends it once they end — but never holds email", async () => {
      const q = await run1("quiet", quietNow(), [sendEmail(), sendSms()], { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      expect(q.run).toMatchObject({ status: "running", nextStep: 1 });
      expect(statuses(q.run)).toEqual(["send_email:sent"]);
      expect(sms.sent).toEqual([]);
      const held = q.run.nextRunAt!.getTime() - Date.now();
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(3 * 3_600_000); // until the window ends, at most ~3h away

      const ok = await run1("not-quiet", quietLater(), [sendSms()], { name: "Ada", phone: "+14155550100" });
      expect(ok.run.status).toBe("completed");
      expect(sms.sent).toHaveLength(1);
    }, 150000);

    it("caps what any one contact receives in a day, and what a workspace sends", async () => {
      const t = await register("caps");
      await createLive(t, def([sendEmail()]));
      const run = await prisma.workflowRun.create({ data: { tenantId: t.tenantId, workflowId: (await prisma.workflow.findFirstOrThrow({ where: { tenantId: t.tenantId } })).id, sourceType: "conversation", sourceId: "seed" } });
      await prisma.workflowStepLog.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ runId: run.id, tenantId: t.tenantId, stepIndex: i, type: "send_email", status: "sent" as const, channel: "email", toHash: contactHash("email", "busy@example.com") })) });
      const c = await lead(t, { name: "Busy", email: "busy@example.com" });
      const r = await enrolAndSettle(t, c.id);
      expect(r.logs[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("Already sent 5") });
      expect(email.sent).toEqual([]);

      process.env.WORKFLOW_DAILY_SEND_CAP = "5"; // the five seeded sends already use the workspace's day
      try {
        const c2 = await lead(t, { name: "Other", email: "other@example.com" });
        const held = await enrolAndSettle(t, c2.id, (x) => x.nextRunAt !== null);
        expect(held.status).toBe("running");
        expect(held.logs).toEqual([]); // held, not skipped
        expect(email.sent).toEqual([]);
        process.env.WORKFLOW_DAILY_SEND_CAP = "500";
        await wake(held.id);
        expect((await settle(c2.id, settled)).logs[0]!.status).toBe("sent");
      } finally {
        delete process.env.WORKFLOW_DAILY_SEND_CAP;
      }
    }, 150000);

    it("sends nothing for a locked workspace, and resumes when it's unlocked", async () => {
      const t = await register("locked");
      await createLive(t, def([sendEmail()]));
      await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "locked" } });
      const c = await lead(t, { name: "Ada", email: "ada@example.com" });
      const held = await enrolAndSettle(t, c.id, (r) => r.nextRunAt !== null);
      expect(held.status).toBe("running");
      expect(email.sent).toEqual([]);
      await prisma.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "active" } });
      await wake(held.id);
      expect((await settle(c.id, settled)).status).toBe("completed");
      expect(email.sent).toHaveLength(1);
    }, 120000);

    it("sends a team notification without the lead's rules or footer", async () => {
      const { run } = await run1("team", {}, [sendEmail({ to: "sales@acme.co", subject: "New lead {{name}}", body: "Budget {{budget}}" })], { name: "Ada", budget: 9000 });
      expect(run.logs[0]!.status).toBe("sent");
      expect(email.sent[0]).toMatchObject({ to: "sales@acme.co", subject: "New lead Ada", text: "Budget 9000" });
      expect(email.sent[0]!.headers).toBeUndefined();
    }, 100000);
  });

  describe("when sending goes wrong", () => {
    it("records a permanent failure and carries on with the next step", async () => {
      const t = await register("perm");
      await createLive(t, def([sendSms(), sendEmail()]));
      sms.script = [{ ok: false, error: "Twilio error 21211", permanent: true }];
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id);
      expect(run.status).toBe("completed");
      expect(run.logs.map((l) => [l.status, l.detail])).toEqual([["failed", "Twilio error 21211"], ["sent", null]]);
    }, 100000);

    it("retries a transient failure, then records it as failed on the final attempt instead of retrying forever", async () => {
      const t = await register("transient");
      await createLive(t, def([sendEmail(), sendSms()]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      email.script = [{ ok: false, error: "Resend error 503" }, { ok: false, error: "Resend error 503" }, { ok: false, error: "Resend error 503" }];
      const run0 = await prisma.workflowRun.create({ data: { tenantId: t.tenantId, workflowId: (await prisma.workflow.findFirstOrThrow({ where: { tenantId: t.tenantId } })).id, sourceType: "conversation", sourceId: c.id } });
      // Attempts 1 and 2 throw so the queue retries; nothing is recorded or advanced.
      await expect(wake(run0.id, 0)).rejects.toThrow("Resend error 503");
      await expect(wake(run0.id, 1)).rejects.toThrow("Resend error 503");
      expect(await prisma.workflowStepLog.count({ where: { runId: run0.id } })).toBe(0);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run0.id } })).nextStep).toBe(0);
      // The last attempt gives up on that email and moves on to the text.
      await wake(run0.id, 2);
      const done = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run0.id }, include: { logs: { orderBy: { stepIndex: "asc" } } } });
      expect(done.status).toBe("completed");
      expect(done.logs.map((l) => l.status)).toEqual(["failed", "sent"]);
      expect(done.logs[0]!.detail).toContain("Resend error 503");
    }, 100000);

    it("a provider reporting the person has opted out is recorded as an opt-out", async () => {
      const t = await register("carrier");
      await createLive(t, def([sendSms(), sendSms("Second")]));
      sms.script = [{ ok: false, error: "Recipient has opted out", permanent: true, optedOut: true }];
      const c = await lead(t, { name: "Ada", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id);
      expect(run.logs.map((l) => [l.status, l.detail])).toEqual([["skipped", "Recipient has opted out"], ["skipped", "Lead opted out of SMS"]]);
      expect(await prisma.optOut.findFirst({ where: { tenantId: t.tenantId, channel: "sms", address: "+14155550100" } })).toMatchObject({ reason: "stop" });
      expect(sms.sent).toEqual([]);
    }, 100000);

    it("fails a run cleanly if the lead's record is gone", async () => {
      const t = await register("gone");
      await createLive(t, def([wait(1), sendEmail()]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 1);
      await prisma.conversation.delete({ where: { id: c.id } });
      await wake(run.id);
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "failed", stopReason: "lead_deleted" });
      expect(email.sent).toEqual([]);
    }, 100000);

    it("the sweeper recovers a run whose wake-up job was lost", async () => {
      const t = await register("sweep");
      await createLive(t, def([sendEmail()]));
      const wf = await prisma.workflow.findFirstOrThrow({ where: { tenantId: t.tenantId } });
      const c = await lead(t, { name: "Ada", email: "ada@example.com" });
      await prisma.workflowRun.create({ data: { tenantId: t.tenantId, workflowId: wf.id, sourceType: "conversation", sourceId: c.id, nextRunAt: new Date(Date.now() - 3_600_000) } });
      expect(await processor.sweep()).toBeGreaterThanOrEqual(1);
      expect((await settle(c.id, settled)).status).toBe("completed");
      expect(email.sent).toHaveLength(1);
    }, 100000);
  });

  describe("unsubscribe and replies", () => {
    async function sentEmailLink(label: string, extra: Record<string, unknown> = {}) {
      const t = await register(label);
      await createLive(t, def([sendEmail(), wait(1), sendEmail({ subject: "Second" })], extra));
      const c = await lead(t, { name: "Ada", email: "ada@example.com" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      const url = /Unsubscribe: (\S+)/.exec(email.sent[0]!.text)![1]!;
      return { t, c, run, url, path: new URL(url).pathname };
    }

    it("a link click only asks for confirmation; confirming unsubscribes, and later emails are skipped", async () => {
      const { t, c, run, path } = await sentEmailLink("unsub");
      const page = await fetch(`${baseUrl}${path}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Unsubscribe");
      expect(await prisma.optOut.count({ where: { tenantId: t.tenantId, address: "ada@example.com" } })).toBe(0); // a scanner fetching the link changes nothing

      const done = await fetch(`${baseUrl}${path}`, { method: "POST" });
      expect(await done.text()).toMatch(/You(&#39;|')re unsubscribed/);
      expect(await prisma.optOut.findFirst({ where: { tenantId: t.tenantId, address: "ada@example.com" } })).toMatchObject({ channel: "email", reason: "unsubscribed" });
      await fetch(`${baseUrl}${path}`, { method: "POST" }); // idempotent
      expect(await prisma.optOut.count({ where: { tenantId: t.tenantId, address: "ada@example.com" } })).toBe(1);

      await wake(run.id);
      const after = await settle(c.id, settled);
      expect(after.logs.at(-1)).toMatchObject({ status: "skipped", detail: "Lead unsubscribed from email" });
      expect(email.sent).toHaveLength(1);
    }, 150000);

    it("rejects a tampered or foreign unsubscribe link", async () => {
      const { t, path } = await sentEmailLink("unsub-bad");
      const token = path.split("/").pop()!;
      for (const bad of [`${token}x`, token.replace(/.$/, "A"), "garbage", `${token}.${token}`]) {
        expect((await fetch(`${baseUrl}/public/unsubscribe/${bad}`)).status, bad).toBe(400);
        expect((await fetch(`${baseUrl}/public/unsubscribe/${bad}`, { method: "POST" })).status, bad).toBe(400);
      }
      expect(await prisma.optOut.count({ where: { tenantId: t.tenantId, address: "ada@example.com" } })).toBe(0);
    }, 100000);

    describe("inbound SMS", () => {
      const post = (form: Record<string, string>, headers: Record<string, string> = {}) =>
        fetch(`${baseUrl}/webhooks/sms`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form) });
      const unsigned = async <T,>(fn: () => Promise<T>) => {
        process.env.SMS_WEBHOOK_ALLOW_UNSIGNED = "true";
        try { return await fn(); } finally { delete process.env.SMS_WEBHOOK_ALLOW_UNSIGNED; }
      };
      async function texted(label: string, settings: object = {}) {
        const t = await register(label);
        await createLive(t, def([sendSms("Hello"), wait(1), sendSms("Again")], { settings: { ...NO_QUIET, ...settings } }));
        const c = await lead(t, { name: "Ada", phone: "+14155550100" });
        const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
        return { t, c, run };
      }

      it("is refused unless signed (or local dev explicitly allows unsigned)", async () => {
        expect((await post({ From: "+14155550100", Body: "STOP" })).status).toBe(403);
        process.env.TWILIO_AUTH_TOKEN = "tok123";
        try {
          expect((await post({ From: "+14155550100", Body: "STOP" }, { "x-twilio-signature": "forged" })).status).toBe(403);
          const params = { From: "+14155550100", Body: "hello" };
          const sig = twilioSignature("tok123", `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/webhooks/sms`, params);
          expect((await post(params, { "x-twilio-signature": sig })).status).toBe(200);
        } finally { delete process.env.TWILIO_AUTH_TOKEN; }
      }, 60000);

      it("STOP opts the person out, so their remaining texts are skipped", async () => {
        const { t, c, run } = await texted("stop");
        const res = await unsigned(() => post({ From: "+1 (415) 555-0100", Body: " Stop. " }));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<Response></Response>");
        expect(await prisma.optOut.findFirst({ where: { tenantId: t.tenantId, channel: "sms", address: "+14155550100" } })).toMatchObject({ reason: "stop" });
        await wake(run.id);
        expect((await settle(c.id, settled)).logs.at(-1)).toMatchObject({ status: "skipped", detail: "Lead opted out of SMS" });
        expect(sms.sent.map((m) => m.body)).toEqual(["Hello\nReply STOP to opt out."]);
      }, 150000);

      it("START brings back a STOP opt-out, but not one the business added by hand", async () => {
        const { t } = await texted("start");
        await unsigned(() => post({ From: "+14155550100", Body: "STOP" }));
        await unsigned(() => post({ From: "+14155550100", Body: "START" }));
        expect(await prisma.optOut.count({ where: { tenantId: t.tenantId, channel: "sms" } })).toBe(0);
        await service.addOptOut(t.tenantId, "sms", "+14155550100");
        await unsigned(() => post({ From: "+14155550100", Body: "START" }));
        expect(await prisma.optOut.count({ where: { tenantId: t.tenantId, channel: "sms", reason: "manual" } })).toBe(1);
      }, 120000);

      it("a reply ends the sequence, unless the workflow says to keep going", async () => {
        const stops = await texted("reply");
        await unsigned(() => post({ From: "+14155550100", Body: "Yes please call me" }));
        expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: stops.run.id } })).toMatchObject({ status: "stopped", stopReason: "replied" });
        await wake(stops.run.id);
        expect(sms.sent).toHaveLength(1); // the follow-up never goes

        sms.sent = [];
        const keeps = await texted("reply-keep", { exitOnReply: false });
        await unsigned(() => post({ From: "+14155550100", Body: "thanks" }));
        expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: keeps.run.id } })).status).toBe("running");
      }, 200000);

      it("ignores numbers we never texted and malformed requests", async () => {
        await unsigned(async () => {
          expect((await post({ From: "+19998887777", Body: "STOP" })).status).toBe(200);
          expect((await post({ Body: "STOP" })).status).toBe(200);
          expect((await post({ From: "garbage", Body: "STOP" })).status).toBe(200);
        });
        expect(await prisma.optOut.count({ where: { address: "+19998887777" } })).toBe(0);
      }, 60000);
    });
  });

  describe("opt-out list", () => {
    it("lets a business add people by hand, validates addresses, and only remove its own entries", async () => {
      const t = await register("optlist");
      expect((await call(t.jwt, "/workflows/opt-outs", { method: "POST", body: { channel: "email", address: "nope" } })).status).toBe(400);
      expect((await call(t.jwt, "/workflows/opt-outs", { method: "POST", body: { channel: "sms", address: "07700 900123" } })).status).toBe(400);
      expect((await call(t.jwt, "/workflows/opt-outs", { method: "POST", body: { channel: "email", address: " Ada@Example.com " } })).status).toBe(201);
      await prisma.optOut.create({ data: { tenantId: t.tenantId, channel: "sms", address: "+14155550100", reason: "stop" } });

      const list = await json<Array<{ id: string; address: string; reason: string }>>(await call(t.jwt, "/workflows/opt-outs"));
      expect(list.map((o) => [o.address, o.reason]).sort()).toEqual([["+14155550100", "stop"], ["ada@example.com", "manual"]]);
      expect(await json<unknown[]>(await call(t.jwt, "/workflows/opt-outs?channel=sms"))).toHaveLength(1);

      const stop = list.find((o) => o.reason === "stop")!;
      const refused = await call(t.jwt, `/workflows/opt-outs/${stop.id}`, { method: "DELETE" });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("chose to opt out");
      expect((await call(t.jwt, `/workflows/opt-outs/${list.find((o) => o.reason === "manual")!.id}`, { method: "DELETE" })).status).toBe(200);

      const other = await register("optlist-other");
      expect(await json<unknown[]>(await call(other.jwt, "/workflows/opt-outs"))).toEqual([]);
      expect((await call(other.jwt, `/workflows/opt-outs/${stop.id}`, { method: "DELETE" })).status).toBe(404);
    }, 120000);
  });


  describe("conditional steps and ending early", () => {
    const when = (field: string, op: string, value?: unknown) => ({ match: "all", conditions: [{ field, op, value }] });

    it("if/else: each lead gets only the branch that fits them, and the log says why the other was skipped", async () => {
      const t = await register("ifelse");
      await createLive(t, def([
        { ...sendEmail({ subject: "VIP" }), when: when("budget", "gt", 5000) },
        { ...sendEmail({ subject: "Standard" }), when: when("budget", "lt", 5001) },
      ]));
      const hot = await enrolAndSettle(t, (await lead(t, { name: "Ada", email: "ada@example.com", budget: 9000 })).id);
      const cold = await enrolAndSettle(t, (await lead(t, { name: "Bob", email: "bob@example.com", budget: 100 })).id);
      expect(email.sent.map((m) => [m.to, m.subject])).toEqual([["ada@example.com", "VIP"], ["bob@example.com", "Standard"]]);
      expect(hot.logs.map((l) => [l.status, l.detail])).toEqual([["sent", null], ["skipped", "Condition not met: budget is less than 5001"]]);
      expect(cold.logs.map((l) => [l.status, l.detail])).toEqual([["skipped", "Condition not met: budget is more than 5000"], ["sent", null]]);
      expect([hot.status, cold.status]).toEqual(["completed", "completed"]);
    }, 150000);

    it("checks a condition when the step is reached, using the lead's data as it is then", async () => {
      const t = await register("late");
      await createLive(t, def([sendEmail(), wait(1), { ...sendSms("Welcome, VIP"), when: when("vip", "equals", "yes") }]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100", vip: "no" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      await prisma.conversation.update({ where: { id: c.id }, data: { capturedData: { name: "Ada", email: "ada@example.com", phone: "+14155550100", vip: "yes" } } });
      await wake(run.id);
      expect((await settle(c.id, settled)).logs.at(-1)!.status).toBe("sent");
      expect(sms.sent.map((m) => m.body)).toEqual(["Welcome, VIP\nReply STOP to opt out."]);
    }, 150000);

    it("“end here” stops the sequence for leads who meet its condition, and nobody else", async () => {
      const t = await register("exit");
      const wf = await createLive(t, def([sendEmail({ subject: "Thanks" }), { type: "exit", when: when("$outcome", "equals", "complaint") }, sendSms("Want to book a demo?")]));
      const complaint = await enrolAndSettle(t, (await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" }, "complaint" as never)).id);
      expect(complaint).toMatchObject({ status: "completed", stopReason: "ended_early" });
      expect(complaint.logs.map((l) => [l.type, l.status, l.detail])).toEqual([["send_email", "sent", null], ["exit", "skipped", "Ended here: outcome is complaint"]]);

      const happy = await enrolAndSettle(t, (await lead(t, { name: "Bob", email: "bob@example.com", phone: "+14155550199" })).id);
      expect(happy).toMatchObject({ status: "completed", stopReason: null });
      expect(happy.logs.map((l) => [l.type, l.status])).toEqual([["send_email", "sent"], ["exit", "skipped"], ["send_sms", "sent"]]);
      expect(sms.sent.map((m) => m.to)).toEqual(["+14155550199"]); // the complaint never got the sales text
      void wf;
    }, 150000);

    it("a wait that doesn't apply is skipped without waiting", async () => {
      const t = await register("skipwait");
      await createLive(t, def([{ ...wait(3), when: when("vip", "equals", "yes") }, sendEmail()]));
      const run = await enrolAndSettle(t, (await lead(t, { name: "Ada", email: "ada@example.com", vip: "no" })).id);
      expect(run.status).toBe("completed");
      expect(run.logs.map((l) => [l.type, l.status])).toEqual([["wait", "skipped"], ["send_email", "sent"]]);
    }, 120000);

    it("won't save an “end here” step without a condition", async () => {
      const t = await register("exitvalid");
      const res = await call(t.jwt, "/workflows", { method: "POST", body: def([sendEmail(), { type: "exit" }]) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("needs a condition");
    }, 60000);

    it("previews which branch a sample lead takes and where it ends", async () => {
      const t = await register("branchpreview");
      const workflow = def([
        { ...sendEmail({ subject: "VIP" }), when: when("budget", "gt", 5000) },
        { ...sendEmail({ subject: "Standard" }), when: when("budget", "lt", 5001) },
        { type: "exit", when: when("$outcome", "equals", "complaint") },
        sendSms("Book a demo?"),
      ]);
      const prev = (data: object, outcome: string | null) => call(t.jwt, "/workflows/preview", { method: "POST", body: { workflow, lead: { data, outcome } } }).then((r) => r.json()) as Promise<{ steps: Array<{ result: string; subject?: string; detail?: string }> }>;
      const vip = await prev({ name: "Ada", email: "ada@example.com", phone: "+14155550100", budget: 9000 }, "demo_booking");
      expect(vip.steps.map((x) => x.result)).toEqual(["send", "skip", "skip", "send"]); // the "end here" doesn't apply to this lead, so it's skipped too
      expect(vip.steps[0]!.subject).toBe("VIP");
      const angry = await prev({ name: "Bob", email: "bob@example.com", budget: 100 }, "complaint");
      expect(angry.steps.map((x) => x.result)).toEqual(["skip", "send", "end"]);
      expect(angry.steps.at(-1)!.detail).toBe("Ends here: outcome is complaint");
    }, 100000);
  });

  describe("runs and previews", () => {
    it("shows a run's step-by-step history and lets a business cancel one in flight", async () => {
      const t = await register("runs");
      const wf = await createLive(t, def([sendEmail(), wait(2), sendSms()]));
      const c = await lead(t, { name: "Ada", email: "ada@example.com", phone: "+14155550100" });
      const run = await enrolAndSettle(t, c.id, (r) => r.nextStep >= 2);
      const detail = await json<{ status: string; workflow: { name: string }; logs: Array<{ stepIndex: number; status: string }> }>(await call(t.jwt, `/workflows/runs/${run.id}`));
      expect(detail).toMatchObject({ status: "running", workflow: { name: "Follow up" } });
      expect(detail.logs.map((l) => l.stepIndex)).toEqual([0, 1]);

      expect((await call(t.jwt, `/workflows/runs/${run.id}/cancel`, { method: "POST" })).status).toBe(201);
      await wake(run.id);
      expect(sms.sent).toEqual([]);
      const runs = await json<Array<{ status: string; stopReason: string }>>(await call(t.jwt, `/workflows/${wf.id}/runs?status=stopped`));
      expect(runs).toEqual([expect.objectContaining({ status: "stopped", stopReason: "cancelled" })]);
      expect((await call(t.jwt, `/workflows/${wf.id}`)).status).toBe(200);
      const listing = await json<{ sentLast30Days: number; workflows: Array<{ runs: Record<string, number> }> }>(await call(t.jwt, "/workflows"));
      expect(listing.sentLast30Days).toBe(1);
      expect(listing.workflows[0]!.runs).toEqual({ stopped: 1 });
    }, 150000);

    it("previews exactly what would happen to a sample lead, sending and enrolling nothing", async () => {
      const t = await register("preview");
      await prisma.optOut.create({ data: { tenantId: t.tenantId, channel: "email", address: "blocked@example.com", reason: "stop" } });
      const workflow = def([sendEmail({ subject: "Hi {{name}}", body: "Re {{company}}" }), wait(2, "hours"), sendSms("Hello {{name}}")], { settings: quietNow(), conditions: { match: "all", conditions: [{ field: "budget", op: "gt", value: 1000 }] } });
      const prev = (lead: object) => call(t.jwt, "/workflows/preview", { method: "POST", body: { workflow, lead } }).then((r) => r.json()) as Promise<{ qualifies: boolean; steps: Array<{ type: string; result: string; atMs: number; detail?: string; to?: string; subject?: string; body?: string; missingVariables?: string[] }> }>;

      const out = await prev({ data: { name: "Ada", email: "ada@example.com", phone: "+14155550100", budget: 5000 }, outcome: "demo_booking" });
      expect(out.qualifies).toBe(true);
      expect(out.steps.map((s) => [s.type, s.result])).toEqual([["send_email", "send"], ["wait", "wait"], ["send_sms", "send"]]);
      expect(out.steps[0]).toMatchObject({ to: "ada@example.com", subject: "Hi Ada", missingVariables: ["company"] });
      expect(out.steps[0]!.body).toContain("Unsubscribe:");
      expect(out.steps[1]!.atMs).toBe(2 * 3_600_000);
      // 2h later the quiet window (which began an hour ago) may still be on: the text is shown as held, with when it would go.
      expect(out.steps[2]!.atMs).toBeGreaterThanOrEqual(2 * 3_600_000);

      expect((await prev({ data: { name: "Bob", email: "bob@example.com", budget: 10 } })).qualifies).toBe(false);
      const skipped = await prev({ data: { name: "Eve", email: "blocked@example.com", phone: "0770", budget: 5000 } });
      expect(skipped.steps.filter((s) => s.type !== "wait").map((s) => [s.result, s.detail])).toEqual([["skip", "Lead unsubscribed from email"], ["skip", "No phone number in international format (+…) in “phone”"]]);

      expect(email.sent).toEqual([]);
      expect(sms.sent).toEqual([]);
      expect(await prisma.workflowRun.count({ where: { tenantId: t.tenantId } })).toBe(0);
    }, 120000);
  });
});
