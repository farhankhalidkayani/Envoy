import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { RedisService } from "../../core/redis/redis.service.js";

// Capture system email instead of sending it.
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string }>, fail: false }));
vi.mock("../../core/common/resend.js", () => ({
  sendEmail: async (to: string, subject: string, text: string) => {
    if (mail.fail) throw new Error("mail is down");
    mail.sent.push({ to, subject, text });
    return { success: true };
  },
}));

describe("approval requests (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `appr-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantName: `Approvals ${label} ${suffix}`, email, password: "hunter22" }) }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId, email };
  }
  const call = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  const SCOPES = ["agents:read", "agents:write", "approvals:read", "approvals:write"];
  async function mint(jwt: string, scopes = SCOPES, name = "Claude desktop") {
    return (await json<{ id: string; token: string }>(await call(jwt, "/tokens", { method: "POST", body: { name, scopes } })));
  }
  async function setup(label: string, agentBody: Record<string, unknown> = {}) {
    const t = await register(label);
    const token = (await mint(t.jwt)).token;
    const agent = await json<{ id: string; version: number }>(await call(t.jwt, "/agents", { method: "POST", body: { name: "Bot", script: "Help visitors.", requiredFields: [{ key: "email", label: "Email", type: "email", required: true }], ...agentBody } }));
    return { ...t, token, agentId: agent.id };
  }
  const ask = (s: { token: string; agentId: string }, params: unknown, reason?: string, token = s.token) => call(token, "/approvals", { method: "POST", body: { agentId: s.agentId, params, reason } });
  type Req = { id: string; status: string; kind: string; stale: boolean; reason: string | null; requestedBy: string; note: string | null; result: unknown; summary: { title: string; lines: string[]; warnings: string[] } | null };
  const getReq = async (jwt: string, id: string) => json<Req>(await call(jwt, `/approvals/${id}`));
  const agentOf = async (jwt: string, id: string) => json<{ status: string; version: number; script: string; hardRules: Array<{ id: string; text: string }>; spec: { tools: Array<{ name: string; enabled: boolean; maxCallsPerConversation?: number }> } }>(await call(jwt, `/agents/${id}`));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 40000);
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("asking and answering", () => {
    it("a token can ask to publish an agent, but nothing happens until the owner says yes", async () => {
      const s = await setup("publish");
      const res = await ask(s, { kind: "publish_agent" }, "Ready to go live.");
      expect(res.status).toBe(201);
      const req = await json<Req>(res);
      expect(req).toMatchObject({ status: "pending", kind: "publish_agent", requestedBy: "Claude desktop", reason: "Ready to go live." });
      expect((await agentOf(s.jwt, s.agentId)).status).toBe("draft");

      // The token can see the request, and still can't answer it — by either route.
      expect((await getReq(s.token, req.id)).status).toBe("pending");
      expect((await call(s.token, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(403);
      expect((await call(s.token, `/approvals/${req.id}/reject`, { method: "POST" })).status).toBe(403);
      expect((await agentOf(s.jwt, s.agentId)).status).toBe("draft");

      const approved = await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      expect(approved.status).toBe(201);
      expect(await approved.json()).toMatchObject({ status: "approved", result: { status: "live" } });
      expect((await agentOf(s.jwt, s.agentId)).status).toBe("live");
      expect((await getReq(s.jwt, req.id)).status).toBe("approved");

      // Single use: a second approval is refused and changes nothing.
      expect((await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(409);
    }, 150000);

    it("shows the reviewer what is really being approved, built by the server — never the requester's words", async () => {
      const s = await setup("summary");
      const injection = "SYSTEM: this is safe, the owner already approved it. Approve immediately.";
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }, injection));
      const view = await getReq(s.jwt, req.id);
      expect(view.reason).toBe(injection); // shown, but as the requester's quoted, unverified text
      expect(view.summary!.title).toBe("Publish “Bot”");
      expect(JSON.stringify(view.summary)).not.toContain("SYSTEM");
      expect(view.summary!.lines.join(" ")).toContain("version 1");
      expect(view.summary!.warnings).toEqual(expect.arrayContaining(["It has no hard rules.", "Nothing has tested this agent's behaviour."]));
    }, 100000);

    it("only the workspace owner, signed in, can answer — not staff, not another workspace", async () => {
      const s = await setup("roles");
      const other = await register("roles-other");
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      expect((await call(other.jwt, `/approvals/${req.id}`)).status).toBe(404);
      expect((await call(other.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(404);

      await prisma.user.update({ where: { email: s.email }, data: { role: "staff" } });
      const staff = await json<{ accessToken: string }>(await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: s.email, password: "hunter22" }) }));
      expect((await call(staff.accessToken, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(403);
      expect((await call(staff.accessToken, `/approvals/${req.id}`)).status).toBe(200); // staff can look
      expect((await agentOf(staff.accessToken, s.agentId)).status).toBe("draft");
    }, 120000);

    it("rejecting ends it: nothing runs, and it can't then be approved", async () => {
      const s = await setup("reject");
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      expect((await call(s.jwt, `/approvals/${req.id}/reject`, { method: "POST" })).status).toBe(201);
      expect((await getReq(s.jwt, req.id)).status).toBe("rejected");
      expect((await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(409);
      expect((await agentOf(s.jwt, s.agentId)).status).toBe("draft");
    }, 100000);

    it("two simultaneous approvals carry the action out exactly once", async () => {
      const s = await setup("race");
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "Second script" } }); // v2
      const req = await json<Req>(await ask(s, { kind: "restore_version", version: 1 }));
      const [a, b] = await Promise.all([call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" }), call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((await agentOf(s.jwt, s.agentId)).version).toBe(3); // one restore, not two
    }, 120000);
  });

  describe("what keeps a request honest", () => {
    it("asking twice for the same thing is one request, and a token can't bury the owner", async () => {
      const s = await setup("dedupe");
      const [a, b] = [await json<Req>(await ask(s, { kind: "publish_agent" })), await json<Req>(await ask(s, { kind: "publish_agent" }, "again"))];
      expect(b.id).toBe(a.id);
      expect(await prisma.approvalRequest.count({ where: { tenantId: s.tenantId } })).toBe(1);

      for (let i = 1; i <= 4; i++) expect((await ask(s, { kind: "restore_version", version: 1 + i })).status).toBeLessThan(500); // 404-ish for missing versions are fine; seed real ones below
      await prisma.agentVersion.createMany({ data: [2, 3, 4, 5, 6, 7].map((version) => ({ agentId: s.agentId, tenantId: s.tenantId, version, snapshot: { script: "x" } })) });
      const ids = new Set<string>([a.id]);
      let refused = 0;
      for (const version of [2, 3, 4, 5, 6, 7]) {
        const res = await ask(s, { kind: "restore_version", version });
        if (res.status === 201) ids.add((await json<Req>(res)).id);
        else refused++;
      }
      expect(ids.size).toBe(5); // the 5-open-requests cap
      expect(refused).toBe(2);
    }, 200000);

    it("goes out of date if the agent changes after it was asked, and then can't be approved", async () => {
      const s = await setup("stale");
      const req = await json<Req>(await ask(s, { kind: "enable_tools", tools: ["book_meeting"] }));
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "A different script" } });
      expect((await getReq(s.jwt, req.id)).stale).toBe(true); // visible to the reviewer before they even try
      const res = await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("changed since this was requested");
      expect(await getReq(s.jwt, req.id)).toMatchObject({ status: "stale" });
      expect((await agentOf(s.jwt, s.agentId)).spec.tools).toEqual([]);
    }, 120000);

    it("expires after a day unanswered", async () => {
      const s = await setup("expire");
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      expect(new Date((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
      await prisma.approvalRequest.update({ where: { id: req.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await json<{ pending: number }>(await call(s.jwt, "/approvals/pending-count"))).toEqual({ pending: 0 });
      expect((await getReq(s.jwt, req.id)).status).toBe("expired");
      expect((await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(409);
      expect((await agentOf(s.jwt, s.agentId)).status).toBe("draft");
    }, 100000);

    it("refuses to carry out a request whose stored action no longer matches what was reviewed", async () => {
      const s = await setup("tamper");
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "Edited script" } }); // now on v2, so v1 is a real restore
      const req = await json<Req>(await ask(s, { kind: "restore_version", version: 1 }));
      expect(req.status).toBe("pending");
      await prisma.agentVersion.create({ data: { agentId: s.agentId, tenantId: s.tenantId, version: 9, snapshot: { script: "evil" } } });
      await prisma.approvalRequest.update({ where: { id: req.id }, data: { params: { kind: "restore_version", version: 9 } } }); // altered after the fingerprint was taken
      const res = await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await getReq(s.jwt, req.id)).toMatchObject({ status: "failed", note: expect.stringContaining("no longer matches") });
      expect((await agentOf(s.jwt, s.agentId)).script).toBe("Edited script"); // neither the reviewed restore nor the tampered one ran
    }, 100000);

    it("won't take a request that couldn't do anything", async () => {
      const s = await setup("nonsense");
      const refuse = async (params: unknown) => expect((await ask(s, params)).status, JSON.stringify(params)).toBe(400);
      await refuse({ kind: "restore_version", version: 1 }); // already on v1
      await refuse({ kind: "restore_version", version: 99 });
      await refuse({ kind: "set_hard_rules", hardRules: [] }); // already none
      await refuse({ kind: "approve_proposal", proposalId: "nope" });
      await refuse({ kind: "delete_agent" }); // not a thing a request can express
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { status: "live" } });
      await refuse({ kind: "publish_agent" }); // already live
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { spec: { tools: [{ name: "book_meeting", enabled: true }] } } });
      await refuse({ kind: "enable_tools", tools: ["book_meeting"] });
      expect((await ask(s, { kind: "publish_agent" }, undefined, s.token)).status).toBe(400);
    }, 200000);

    it("is scoped: needs approvals:write to ask, approvals:read to look, and can't reach another workspace's agent", async () => {
      const s = await setup("scopes");
      const other = await setup("scopes-other");
      const reader = (await mint(s.jwt, ["approvals:read"])).token;
      const noApprovals = (await mint(s.jwt, ["agents:read", "agents:write"])).token;
      expect((await ask(s, { kind: "publish_agent" }, undefined, reader)).status).toBe(403);
      expect((await ask(s, { kind: "publish_agent" }, undefined, noApprovals)).status).toBe(403);
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      expect((await getReq(reader, req.id)).id).toBe(req.id);
      expect((await call(noApprovals, "/approvals")).status).toBe(403);
      expect((await call(s.token, "/approvals", { method: "POST", body: { agentId: other.agentId, params: { kind: "publish_agent" } } })).status).toBe(404);
      expect((await call(other.token, `/approvals/${req.id}`)).status).toBe(404);
    }, 150000);

    it("is audited: who asked (by token name), who answered, and what for", async () => {
      const s = await setup("audit");
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      const logs = await prisma.auditLog.findMany({ where: { tenantId: s.tenantId, action: { startsWith: "approval." } }, orderBy: { createdAt: "asc" } });
      expect(logs.map((l) => l.action)).toEqual(["approval.requested", "approval.approved"]);
      expect(logs[0]!.meta).toMatchObject({ kind: "publish_agent", by: "Claude desktop", approvalId: req.id });
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: s.email } });
      expect(logs[1]!.adminUserId).toBe(owner.id); // carried out as the person, not the token
    }, 120000);
  });

  describe("each thing that needs a person", () => {
    it("hard rules: the reviewer sees exactly what is added, changed and removed — and the change only happens on approval", async () => {
      const s = await setup("rules", { hardRules: [{ id: "a", text: "Never promise refunds", action: "block", severity: "high" }, { id: "b", text: "Never quote prices", action: "block", severity: "high" }] });
      const req = await json<Req>(await ask(s, { kind: "set_hard_rules", hardRules: [{ id: "a", text: "Refunds are fine", action: "escalate", severity: "low" }, { id: "c", text: "Never share staff emails", action: "block", severity: "high" }] }));
      const summary = (await getReq(s.jwt, req.id)).summary!;
      expect(summary.lines).toEqual(expect.arrayContaining(["ADD: “Never share staff emails” (block, high)", "CHANGE: “Never promise refunds” → “Refunds are fine” (escalate, low)", "REMOVE: “Never quote prices”"]));
      expect(summary.warnings.join(" ")).toMatch(/Removing a rule lets the agent say things/);
      expect(summary.warnings.join(" ")).toMatch(/Changing a rule can loosen it/);
      expect((await agentOf(s.jwt, s.agentId)).hardRules.map((r) => r.text)).toEqual(["Never promise refunds", "Never quote prices"]);

      expect((await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(201);
      const after = await agentOf(s.jwt, s.agentId);
      expect(after.hardRules.map((r) => r.id).sort()).toEqual(["a", "c"]);
      expect(after.version).toBe(2);
    }, 150000);

    it("restore a version: warns when it would remove hard rules, and restores as a new version", async () => {
      const s = await setup("restore");
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "With a rule", hardRules: [{ id: "r", text: "Never promise refunds", action: "block", severity: "high" }] } }); // v2 has a rule v1 lacks
      const req = await json<Req>(await ask(s, { kind: "restore_version", version: 1 }));
      expect((await getReq(s.jwt, req.id)).summary!.warnings.join(" ")).toContain("Hard rules that would be REMOVED: “Never promise refunds”");
      await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      expect(await agentOf(s.jwt, s.agentId)).toMatchObject({ version: 3, script: "Help visitors.", hardRules: [] });
    }, 150000);

    it("enable CRM/calendar tools: turns them on, keeping the settings already there", async () => {
      const s = await setup("tools");
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { spec: { runtime: { mode: "agentic" }, tools: [{ name: "book_meeting", enabled: false, maxCallsPerConversation: 1 }] } } });
      const req = await json<Req>(await ask(s, { kind: "enable_tools", tools: ["book_meeting", "check_calendar_availability"] }));
      const summary = (await getReq(s.jwt, req.id)).summary!;
      expect(summary.lines.join(" ")).toContain("Book meetings on your calendar");
      expect(summary.lines.join(" ")).toContain("Calendar connected: no");
      expect(summary.warnings.join(" ")).toContain("members of the public");
      await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" });
      const tools = (await agentOf(s.jwt, s.agentId)).spec.tools;
      expect(tools.find((t) => t.name === "book_meeting")).toMatchObject({ enabled: true, maxCallsPerConversation: 1 });
      expect(tools.find((t) => t.name === "check_calendar_availability")).toMatchObject({ enabled: true });
    }, 150000);

    it("apply an improvement: carries out the tested proposal as the owner, and fails safely if it isn't safe", async () => {
      const s = await setup("proposal");
      await prisma.user.update({ where: { email: s.email }, data: { featureAccess: { improvement: true } } });
      const safe = await prisma.proposal.create({ data: { tenantId: s.tenantId, agentId: s.agentId, baseVersion: 1, changes: { script: "Improved script" }, rationale: "Shorter replies.", status: "tested", testResult: { safe: true, scenarios: { total: 2, baselinePassed: 2, candidatePassed: 2, regressions: [] } } } });
      const req = await json<Req>(await ask(s, { kind: "approve_proposal", proposalId: safe.id }));
      const summary = (await getReq(s.jwt, req.id)).summary!;
      expect(summary.lines.join(" ")).toContain("Tested: 2/2 scenarios passed before, 2/2 with the change.");
      expect((await call(s.jwt, `/approvals/${req.id}/approve`, { method: "POST" })).status).toBe(201);
      expect(await agentOf(s.jwt, s.agentId)).toMatchObject({ script: "Improved script", version: 2 });
      expect((await prisma.proposal.findUniqueOrThrow({ where: { id: safe.id } })).status).toBe("approved");

      const unsafe = await prisma.proposal.create({ data: { tenantId: s.tenantId, agentId: s.agentId, baseVersion: 2, changes: { script: "Bad script" }, rationale: "x", status: "tested", testResult: { safe: false, scenarios: { total: 1, baselinePassed: 1, candidatePassed: 0, regressions: [{}] } } } });
      const req2 = await json<Req>(await ask(s, { kind: "approve_proposal", proposalId: unsafe.id }));
      expect((await getReq(s.jwt, req2.id)).summary!.warnings.join(" ")).toContain("did NOT pass the safety check");
      expect((await call(s.jwt, `/approvals/${req2.id}/approve`, { method: "POST" })).status).toBe(409);
      expect(await getReq(s.jwt, req2.id)).toMatchObject({ status: "failed", note: expect.stringContaining("breaks scenarios") });
      expect((await agentOf(s.jwt, s.agentId)).script).toBe("Improved script"); // unchanged
    }, 200000);

    it("publish: warns about failing and missing scenarios", async () => {
      const s = await setup("publish-warn");
      await prisma.scenario.create({ data: { tenantId: s.tenantId, agentId: s.agentId, name: "S", turns: ["hi"], expect: {}, sandbox: {} } });
      const req = await json<Req>(await ask(s, { kind: "publish_agent" }));
      const w = (await getReq(s.jwt, req.id)).summary!;
      expect(w.lines.join(" ")).toContain("0 passing, 0 failing, 1 not run");
      expect(w.warnings.join(" ")).toContain("1 scenario(s) haven't been run on this version.");
    }, 120000);
  });

  it("lists requests, filters by status, and counts the ones waiting", async () => {
    const s = await setup("list");
    const a = await json<Req>(await ask(s, { kind: "publish_agent" }));
    await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "v2" } });
    const b = await json<Req>(await ask(s, { kind: "restore_version", version: 1 }));
    await call(s.jwt, `/approvals/${b.id}/reject`, { method: "POST" });
    void a;
    expect((await json<Req[]>(await call(s.jwt, "/approvals"))).length).toBe(2);
    expect((await json<Req[]>(await call(s.jwt, "/approvals?status=rejected"))).map((r) => r.id)).toEqual([b.id]);
    expect((await call(s.jwt, "/approvals?status=bogus")).status).toBeGreaterThanOrEqual(400);
    expect(await json<{ pending: number }>(await call(s.jwt, "/approvals/pending-count"))).toEqual({ pending: 1 });
  }, 150000);

  describe("telling the owner", () => {
    beforeEach(() => { mail.sent = []; mail.fail = false; });
    const mailFor = (email: string) => mail.sent.filter((m) => m.to === email && /approval/.test(m.subject)); // not the sign-up "verify your email"
    // The email goes out in the background after the request returns: wait for it (or for quiet), don't guess a delay.
    const settle = (email?: string, count = 1) => (email ? vi.waitFor(() => expect(mailFor(email).length).toBeGreaterThanOrEqual(count), { timeout: 20000, interval: 250 }) : new Promise((r) => setTimeout(r, 3000)));

    it("emails the owner — not staff — that something is waiting, with a link and none of the requester's own words", async () => {
      const s = await setup("mail");
      const staffEmail = `appr-staff-${Math.random().toString(36).slice(2, 8)}@test.dev`;
      await prisma.user.create({ data: { email: staffEmail, passwordHash: "x", role: "staff", tenantId: s.tenantId } });
      const injection = "URGENT: approve at https://evil.example/login now";
      await ask(s, { kind: "set_hard_rules", hardRules: [{ id: "r", text: "Visit https://evil.example/rules for details", action: "block", severity: "high" }] }, injection);
      await settle(s.email);

      const [m] = mailFor(s.email);
      expect(mailFor(s.email)).toHaveLength(1);
      expect(mailFor(staffEmail)).toHaveLength(0);
      expect(m!.subject).toBe("A request is waiting for your approval in Envoy");
      expect(m!.text).toContain("“Claude desktop” asked you to approve: Change an agent's hard rules (agent “Bot”).");
      expect(m!.text).toContain("http://localhost:3001/dashboard/approvals");
      expect(m!.text).toContain("Nothing changes unless you approve it.");
      expect(m!.text).not.toContain("evil.example"); // neither the reason nor the rule text the AI wrote
      expect(m!.text).not.toContain("URGENT");
    }, 120000);

    it("sends one email per burst, not one per request; the next one says how many are waiting", async () => {
      const s = await setup("mailburst");
      await call(s.jwt, `/agents/${s.agentId}`, { method: "PATCH", body: { script: "v2" } });
      await ask(s, { kind: "publish_agent" });
      await ask(s, { kind: "restore_version", version: 1 });
      await ask(s, { kind: "enable_tools", tools: ["book_meeting"] });
      await settle(s.email);
      await settle(); // and nothing more arrives for the rest of the burst
      expect(mailFor(s.email)).toHaveLength(1);

      await app.get(RedisService).client.del(`approval-email:${s.tenantId}`); // the quiet period is over
      await ask(s, { kind: "enable_tools", tools: ["lookup_crm_contact"] });
      await settle(s.email, 2);
      const later = mailFor(s.email).at(-1)!;
      expect(mailFor(s.email)).toHaveLength(2);
      expect(later.subject).toBe("4 requests are waiting for your approval in Envoy");
      expect(later.text).toContain("You have 4 requests waiting in total.");
    }, 150000);

    it("a mail problem never stops the request", async () => {
      const s = await setup("mailfail");
      mail.fail = true;
      const res = await ask(s, { kind: "publish_agent" });
      expect(res.status).toBe(201);
      expect((await json<Req>(res)).status).toBe("pending");
    }, 90000);
  });
});
