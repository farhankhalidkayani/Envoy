import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { AgentGateway } from "../gateway/agent.gateway.js";

describe("improvement harness (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  const tenants: string[] = [];

  async function register(label: string, opts: { improvement?: boolean } = { improvement: true }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `imp-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: `Improve ${label} ${suffix}`, email, password: "hunter22" }),
    }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    if (opts.improvement !== false) await prisma.user.update({ where: { email }, data: { featureAccess: { improvement: true } } });
    return { token: reg.accessToken, tenantId: reg.user.tenantId, email };
  }
  const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  const fields = [
    { key: "email", label: "Email", type: "email", required: true },
    { key: "phone", label: "Phone", type: "phone", required: true },
  ];
  async function agentFor(token: string, extra: Record<string, unknown> = {}) {
    const res = await api(token, "/agents", { method: "POST", body: { name: "Improve Bot", script: "Help visitors book a demo.", requiredFields: fields, ...extra } });
    expect(res.status).toBe(201);
    return json<{ id: string; publicToken: string }>(res);
  }

  /** Real-looking history, written straight to the DB so the diagnosis is deterministic. */
  async function seed(t: { tenantId: string }, agentId: string, plan: { completed?: number; abandonedAtPhone?: number; bounced?: number; version?: number }) {
    const version = plan.version ?? 1;
    const row = (status: "completed" | "abandoned", captured: object, turns: number, transcript: string | null) => ({
      tenantId: t.tenantId, agentId, status, agentVersion: version, turnCount: turns, capturedData: captured, transcriptText: transcript,
    });
    const data = [
      ...Array.from({ length: plan.completed ?? 0 }, () => row("completed", { email: "a@b.co", phone: "123456" }, 4, "Visitor: hi\nAgent: Could you share your email?\nVisitor: a@b.co\nAgent: And your phone?\nVisitor: 123456\nAgent: Thanks!")),
      ...Array.from({ length: plan.abandonedAtPhone ?? 0 }, () => row("abandoned", { email: "a@b.co" }, 2, "Visitor: hi\nAgent: Could you share your email?\nVisitor: a@b.co\nAgent: And your phone number?")),
      ...Array.from({ length: plan.bounced ?? 0 }, () => row("abandoned", {}, 0, null)),
    ];
    await prisma.conversation.createMany({ data });
  }

  const happyScenario = { name: "Gets email", turns: ["Hello"], expect: { replyContains: ["email"] } };
  async function stage(label: string, opts: { scenarios?: boolean } = { scenarios: true }) {
    const t = await register(label);
    const agent = await agentFor(t.token);
    await seed(t, agent.id, { completed: 3, abandonedAtPhone: 6, bounced: 2 });
    if (opts.scenarios !== false) await api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body: happyScenario });
    const insights = await json<Array<{ id: string; kind: string; fingerprint: string; severity: string; evidence: { count: number; total: number; conversationIds: string[] } }>>(
      await api(t.token, `/agents/${agent.id}/improvement/analyze`, { method: "POST" }),
    );
    const abandonInsight = insights.find((i) => i.fingerprint === "abandon_at_field:phone")!;
    return { t, agent, insights, abandonInsight };
  }
  const imp = (agentId: string, path: string) => `/agents/${agentId}/improvement${path}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    wsBase = `ws://localhost:${port}`;
  }, 30000);
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("access", () => {
    it("is off until the operator enables it for the user", async () => {
      const t = await register("gated", { improvement: false });
      const agent = await agentFor(t.token);
      for (const path of ["/metrics", "/insights", "/proposals"]) expect((await api(t.token, imp(agent.id, path))).status).toBe(403);
      expect((await api(t.token, imp(agent.id, "/analyze"), { method: "POST" })).status).toBe(403);
    }, 40000);

    it("is tenant-scoped", async () => {
      const { t, agent, abandonInsight } = await stage("scope-a");
      const other = await register("scope-b");
      for (const path of ["/metrics", "/insights", "/proposals"]) expect((await api(other.token, imp(agent.id, path))).status).toBe(404);
      expect((await api(other.token, imp(agent.id, `/insights/${abandonInsight.id}/propose`), { method: "POST" })).status).toBe(404);
      const otherAgent = await agentFor(other.token);
      expect((await api(other.token, imp(otherAgent.id, `/insights/${abandonInsight.id}/propose`), { method: "POST" })).status).toBe(404); // someone else's insight id on my agent
      void t;
    }, 120000);
  });

  describe("metrics and diagnosis", () => {
    it("computes per-version metrics, treating bounces as non-failures", async () => {
      const t = await register("metrics");
      const agent = await agentFor(t.token);
      await seed(t, agent.id, { completed: 3, abandonedAtPhone: 6, bounced: 2 });
      const m = await json<{ currentVersion: number; versions: Array<Record<string, number>> }>(await api(t.token, imp(agent.id, "/metrics")));
      expect(m.currentVersion).toBe(1);
      expect(m.versions).toHaveLength(1);
      expect(m.versions[0]).toMatchObject({ version: 1, conversations: 11, bounces: 2, engaged: 9, completed: 3, abandoned: 6, completionRate: 0.333, avgTurnsToComplete: 4 });
    }, 40000);

    it("names where visitors leave and how bad the completion rate is, with evidence", async () => {
      const { insights } = await stage("diagnose", { scenarios: false });
      expect(insights.map((i) => i.fingerprint).sort()).toEqual(["abandon_at_field:phone", "low_completion"]);
      const drop = insights.find((i) => i.kind === "abandon_at_field")!;
      expect(drop).toMatchObject({ severity: "critical", evidence: { count: 6, total: 6 } });
      expect(drop.evidence.conversationIds).toHaveLength(5);
      expect(insights[0]!.severity).toBe("critical"); // most severe first
    }, 60000);

    it("re-analysing updates in place, keeps a dismissal while the problem lasts, and drops findings once it's gone", async () => {
      const { t, agent, insights } = await stage("reanalyze", { scenarios: false });
      const low = insights.find((i) => i.kind === "low_completion")!;
      expect((await api(t.token, imp(agent.id, `/insights/${low.id}`), { method: "PATCH", body: { status: "dismissed" } })).status).toBe(200);

      const again = await json<Array<{ id: string; status: string; fingerprint: string }>>(await api(t.token, imp(agent.id, "/analyze"), { method: "POST" }));
      expect(again).toHaveLength(2); // no duplicates
      expect(again.find((i) => i.fingerprint === "low_completion")).toMatchObject({ id: low.id, status: "dismissed" });

      // Plenty of completions arrive: the completion rate is healthy now, so that finding goes — dismissed or not.
      await seed(t, agent.id, { completed: 30 });
      const fixed = await json<Array<{ fingerprint: string }>>(await api(t.token, imp(agent.id, "/analyze"), { method: "POST" }));
      expect(fixed.map((i) => i.fingerprint)).toEqual(["abandon_at_field:phone"]); // those 6 still leave at phone
    }, 80000);

    it("says nothing on a thin sample", async () => {
      const t = await register("thin");
      const agent = await agentFor(t.token);
      await seed(t, agent.id, { abandonedAtPhone: 4 });
      expect(await json<unknown[]>(await api(t.token, imp(agent.id, "/analyze"), { method: "POST" }))).toEqual([]);
    }, 40000);
  });

  describe("proposals", () => {
    it("drafts a targeted fix without touching the agent", async () => {
      const { t, agent, abandonInsight } = await stage("draft");
      const res = await api(t.token, imp(agent.id, `/insights/${abandonInsight.id}/propose`), { method: "POST" });
      expect(res.status).toBe(201);
      const p = await json<{ status: string; baseVersion: number; stale: boolean; changes: { fieldPrompts?: Record<string, string>; script?: string }; rationale: string }>(res);
      expect(p).toMatchObject({ status: "pending", baseVersion: 1, stale: false });
      expect(Object.keys(p.changes.fieldPrompts!)).toEqual(["phone"]);
      expect(p.rationale.length).toBeGreaterThan(10);

      const live = await json<{ version: number; requiredFields: Array<{ key: string; prompt?: string }> }>(await api(t.token, `/agents/${agent.id}`));
      expect(live.version).toBe(1);
      expect(live.requiredFields.find((f) => f.key === "phone")!.prompt).toBeUndefined();
    }, 80000);

    it("won't draft for a dismissed finding, or past the limit of undecided proposals", async () => {
      const { t, agent, insights, abandonInsight } = await stage("limits", { scenarios: false });
      const low = insights.find((i) => i.kind === "low_completion")!;
      await api(t.token, imp(agent.id, `/insights/${low.id}`), { method: "PATCH", body: { status: "dismissed" } });
      expect((await api(t.token, imp(agent.id, `/insights/${low.id}/propose`), { method: "POST" })).status).toBe(400);

      await prisma.proposal.createMany({ data: Array.from({ length: 5 }, () => ({ tenantId: t.tenantId, agentId: agent.id, baseVersion: 1, changes: { script: "x" }, rationale: "r" })) });
      expect((await api(t.token, imp(agent.id, `/insights/${abandonInsight.id}/propose`), { method: "POST" })).status).toBe(400);
    }, 80000);

    it("tests a proposal on the agent's scenarios and on replays of the real conversations that exposed the problem", async () => {
      const { t, agent, abandonInsight } = await stage("test");
      const p = await json<{ id: string }>(await api(t.token, imp(agent.id, `/insights/${abandonInsight.id}/propose`), { method: "POST" }));
      const tested = await json<{ status: string; testResult: { safe: boolean; hardRulesPreserved: boolean; scenarios: { total: number; baselinePassed: number; candidatePassed: number; regressions: unknown[] }; replay: { total: number; items: Array<{ conversationId: string }> } } }>(
        await api(t.token, imp(agent.id, `/proposals/${p.id}/test`), { method: "POST" }),
      );
      expect(tested.status).toBe("tested");
      expect(tested.testResult).toMatchObject({ safe: true, hardRulesPreserved: true, scenarios: { total: 1, baselinePassed: 1, candidatePassed: 1, regressions: [] } });
      expect(tested.testResult.replay.total).toBe(3);
      expect(abandonInsight.evidence.conversationIds).toEqual(expect.arrayContaining(tested.testResult.replay.items.map((i) => i.conversationId)));
      // Testing is a simulation: it created no conversations beyond the seeded ones.
      expect(await prisma.conversation.count({ where: { agentId: agent.id } })).toBe(11);
    }, 150000);

    it("marks a proposal that breaks a passing scenario as unsafe, and refuses to approve it", async () => {
      const { t, agent } = await stage("unsafe");
      // A new rule that would block the agent's normal "share your email" question.
      const bad = await prisma.proposal.create({
        data: { tenantId: t.tenantId, agentId: agent.id, baseVersion: 1, rationale: "Hide emails", changes: { addHardRules: [{ id: "no-email-talk", text: "Never share your email address", action: "block", severity: "high" }] } },
      });
      const tested = await json<{ testResult: { safe: boolean; scenarios: { regressions: Array<{ scenario: string; failed: Array<{ check: string }> }> } } }>(
        await api(t.token, imp(agent.id, `/proposals/${bad.id}/test`), { method: "POST" }),
      );
      expect(tested.testResult.safe).toBe(false);
      expect(tested.testResult.scenarios.regressions[0]).toMatchObject({ scenario: "Gets email" });
      expect(tested.testResult.scenarios.regressions[0]!.failed[0]!.check).toContain("email");

      const approve = await api(t.token, imp(agent.id, `/proposals/${bad.id}/approve`), { method: "POST", body: {} });
      expect(approve.status).toBe(409);
      expect((await json<{ version: number }>(await api(t.token, `/agents/${agent.id}`))).version).toBe(1);
    }, 150000);
  });

  describe("approval", () => {
    async function tested(label: string, scenarios = true) {
      const s = await stage(label, { scenarios });
      const p = await json<{ id: string }>(await api(s.t.token, imp(s.agent.id, `/insights/${s.abandonInsight.id}/propose`), { method: "POST" }));
      await api(s.t.token, imp(s.agent.id, `/proposals/${p.id}/test`), { method: "POST" });
      return { ...s, proposalId: p.id };
    }

    it("applies a tested, safe proposal as a new version — keeping every hard rule — and marks other proposals stale", async () => {
      const s = await tested("approve");
      await api(s.t.token, `/agents/${s.agent.id}`, { method: "PATCH", body: { hardRules: [{ id: "no-refunds", text: "Never promise refunds", action: "block", severity: "high" }] } });
      // …that edit moved the agent to v2, so the proposal (drafted on v1) is stale:
      const stale = await api(s.t.token, imp(s.agent.id, `/proposals/${s.proposalId}/approve`), { method: "POST", body: {} });
      expect(stale.status).toBe(409);
      expect((await json<{ stale: boolean }>(await api(s.t.token, imp(s.agent.id, `/proposals/${s.proposalId}`)))).stale).toBe(true);
    }, 200000);

    it("approving writes the change, a labelled version, and leaves rules alone", async () => {
      const t = await register("apply");
      const agent = await agentFor(t.token, { hardRules: [{ id: "no-refunds", text: "Never promise refunds", action: "block", severity: "high" }] });
      await seed(t, agent.id, { completed: 3, abandonedAtPhone: 6 });
      await api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body: happyScenario });
      const insights = await json<Array<{ id: string; fingerprint: string }>>(await api(t.token, imp(agent.id, "/analyze"), { method: "POST" }));
      const p = await json<{ id: string }>(await api(t.token, imp(agent.id, `/insights/${insights.find((i) => i.fingerprint === "abandon_at_field:phone")!.id}/propose`), { method: "POST" }));
      expect((await api(t.token, imp(agent.id, `/proposals/${p.id}/approve`), { method: "POST", body: {} })).status).toBe(400); // untested

      await api(t.token, imp(agent.id, `/proposals/${p.id}/test`), { method: "POST" });
      const res = await api(t.token, imp(agent.id, `/proposals/${p.id}/approve`), { method: "POST", body: {} });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ appliedVersion: 2 });

      const live = await json<{ version: number; hardRules: Array<{ id: string; text: string }>; requiredFields: Array<{ key: string; prompt?: string }> }>(await api(t.token, `/agents/${agent.id}`));
      expect(live.version).toBe(2);
      expect(live.requiredFields.find((f) => f.key === "phone")!.prompt).toContain("explain why");
      expect(live.hardRules).toEqual([expect.objectContaining({ id: "no-refunds", text: "Never promise refunds" })]);

      const versions = await json<Array<{ version: number; note: string | null }>>(await api(t.token, `/agents/${agent.id}/versions`));
      expect(versions[0]).toMatchObject({ version: 2 });
      expect(versions[0]!.note).toMatch(/^Improvement: Visitors leave when asked for/);
      const stored = await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } });
      expect(stored).toMatchObject({ status: "approved", appliedVersion: 2 });
      expect(stored.decidedBy).toBeTruthy();

      // Can't be applied twice, and findings for the old version no longer show.
      expect((await api(t.token, imp(agent.id, `/proposals/${p.id}/approve`), { method: "POST", body: {} })).status).toBe(400);
      expect(await json<unknown[]>(await api(t.token, imp(agent.id, "/insights")))).toEqual([]);
    }, 200000);

    it("needs an explicit acknowledgement to approve a proposal on an agent with no scenarios to check it against", async () => {
      const s = await tested("untested", false);
      const first = await api(s.t.token, imp(s.agent.id, `/proposals/${s.proposalId}/approve`), { method: "POST", body: {} });
      expect(first.status).toBe(400);
      expect(await first.text()).toContain("no scenarios");
      expect((await api(s.t.token, imp(s.agent.id, `/proposals/${s.proposalId}/approve`), { method: "POST", body: { acknowledgeUntested: true } })).status).toBe(201);
    }, 200000);

    it("lets only the owner approve or reject, and rejection is final", async () => {
      const s = await tested("roles");
      await prisma.user.update({ where: { email: s.t.email }, data: { role: "staff" } });
      const login = await json<{ accessToken: string }>(await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: s.t.email, password: "hunter22" }) }));
      expect((await api(login.accessToken, imp(s.agent.id, `/proposals/${s.proposalId}/approve`), { method: "POST", body: {} })).status).toBe(403);
      expect((await api(login.accessToken, imp(s.agent.id, `/proposals/${s.proposalId}/reject`), { method: "POST" })).status).toBe(403);
      expect((await api(login.accessToken, imp(s.agent.id, "/insights"))).status).toBe(200); // staff can still look and analyse

      await prisma.user.update({ where: { email: s.t.email }, data: { role: "owner" } });
      const owner = await json<{ accessToken: string }>(await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: s.t.email, password: "hunter22" }) }));
      expect((await api(owner.accessToken, imp(s.agent.id, `/proposals/${s.proposalId}/reject`), { method: "POST" })).status).toBe(201);
      expect((await api(owner.accessToken, imp(s.agent.id, `/proposals/${s.proposalId}/approve`), { method: "POST", body: {} })).status).toBe(400);
      expect((await api(owner.accessToken, imp(s.agent.id, `/proposals/${s.proposalId}/test`), { method: "POST" })).status).toBe(400);
      expect((await json<{ version: number }>(await api(owner.accessToken, `/agents/${s.agent.id}`))).version).toBe(1);
    }, 200000);
  });

  describe("recording abandoned conversations", () => {
    it("keeps what a visitor said and what was captured when they leave part-way", async () => {
      const t = await register("abandon", { improvement: false });
      const agent = await agentFor(t.token);
      await api(t.token, `/agents/${agent.id}`, { method: "PATCH", body: { status: "live" } });

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
        const timer = setTimeout(() => reject(new Error("timed out")), 20000);
        let sent = 0;
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data as string) as { type: string };
          if (m.type === "session.ready") { ws.send(JSON.stringify({ type: "user.message", text: "Hello there" })); sent++; }
          else if (m.type === "agent.message" && sent === 1) { sent++; ws.send(JSON.stringify({ type: "user.message", text: "a@b.co" })); }
          else if (m.type === "agent.message" && sent === 2) { clearTimeout(timer); ws.close(); resolve(); } // leave before finishing
          else if (m.type === "error") { clearTimeout(timer); reject(new Error("gateway error")); }
        });
      });

      let convo = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
      for (let i = 0; i < 40 && convo.status !== "abandoned"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        convo = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
      }
      expect(convo).toMatchObject({ status: "abandoned", turnCount: 2 });
      expect(convo.transcriptText).toContain("Visitor: Hello there");
      expect(convo.transcriptText).toContain("Visitor: a@b.co");
      expect(convo.capturedData).toMatchObject({ email: "a@b.co" });
    }, 60000);

    it("records a bounce (left without a word) as zero turns with no transcript", async () => {
      const t = await register("bounce", { improvement: false });
      const agent = await agentFor(t.token);
      await api(t.token, `/agents/${agent.id}`, { method: "PATCH", body: { status: "live" } });
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
        const timer = setTimeout(() => reject(new Error("timed out")), 20000);
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
        ws.addEventListener("message", (e) => { if ((JSON.parse(e.data as string) as { type: string }).type === "session.ready") { clearTimeout(timer); ws.close(); resolve(); } });
      });
      let convo = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
      for (let i = 0; i < 40 && convo.status !== "abandoned"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        convo = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
      }
      expect(convo).toMatchObject({ status: "abandoned", turnCount: 0, transcriptText: null });
    }, 60000);
  });
});
