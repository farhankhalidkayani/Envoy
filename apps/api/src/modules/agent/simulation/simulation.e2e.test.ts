import type { Server as HttpServer } from "node:http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { ModelProviderFactory } from "../../models/provider-factory.js";
import { AgentGateway } from "../gateway/agent.gateway.js";
import { MockLlmProvider } from "../providers/llm/mock.provider.js";
import type { LlmProvider } from "../providers/llm/types.js";

/** Behaves like the mock model, but records which model served each call and reports token usage. */
class FakeFactory extends ModelProviderFactory {
  calls: Array<{ model: string; purpose: string }> = [];
  override create(_kind: Parameters<ModelProviderFactory["create"]>[0], _key: string, model: string): LlmProvider {
    const mock = new MockLlmProvider();
    return {
      name: "fake",
      model,
      complete: async (r) => { this.calls.push({ model, purpose: r.purpose }); return { ...(await mock.complete(r)), usage: { inputTokens: 10, outputTokens: 4 } }; },
      completeWithTools: async (r) => { this.calls.push({ model, purpose: "chat" }); return { ...(await mock.completeWithTools(r)), usage: { inputTokens: 20, outputTokens: 6 } }; },
      judge: async (t, rules) => { this.calls.push({ model, purpose: "judge" }); return mock.judge(t, rules); },
    };
  }
}

describe("playground & scenarios (e2e)", () => {
  const fake = new FakeFactory();
  let app: INestApplication;
  let baseUrl: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = (await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: `Sim ${label} ${suffix}`, email: `sim-${label}-${suffix}@test.dev`, password: "hunter22" }),
    }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { token: reg.accessToken, tenantId: reg.user.tenantId };
  }
  const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  const optIn = [{ name: "lookup_crm_contact" }, { name: "check_calendar_availability" }, { name: "book_meeting" }];
  async function agentFor(token: string, body: Record<string, unknown> = {}) {
    const res = await api(token, "/agents", {
      method: "POST",
      body: {
        name: "Sim Bot",
        requiredFields: [{ key: "email", label: "Email", type: "email", required: true }],
        spec: {
          goals: [{ id: "qualify", title: "Qualify", successCriteria: "has email" }],
          tools: optIn,
          runtime: { mode: "agentic", extractionFallback: false },
        },
        ...body,
      },
    });
    expect(res.status).toBe(201);
    return json<{ id: string }>(res); // never published: simulations don't need a live agent
  }

  interface Turn { sessionId: string; reply: string; isComplete: boolean; outcomeType?: string; handoffReason?: string; capturedData: Record<string, unknown>; goalProgress: Record<string, { status: string }>; steps: Array<{ kind: string; name: string; error?: string }>; agentVersion: number }
  const simulate = (token: string, agentId: string, message: string, extra: Record<string, unknown> = {}) =>
    api(token, `/agents/${agentId}/simulate`, { method: "POST", body: { message, ...extra } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ModelProviderFactory).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as { port: number }).port}`;
  }, 30000);
  beforeEach(() => { fake.calls = []; });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("playground", () => {
    it("runs a multi-turn conversation on a draft agent and returns what the agent did, leaving no trace behind", async () => {
      const t = await register("play");
      const agent = await agentFor(t.token);

      const first = await json<Turn>(await simulate(t.token, agent.id, "Hello"));
      expect(first.reply).toContain("email");
      expect(first.isComplete).toBe(false);
      expect(first.sessionId).toBeTruthy();

      const second = await json<Turn>(await simulate(t.token, agent.id, "ada@example.com", { sessionId: first.sessionId }));
      expect(second).toMatchObject({ sessionId: first.sessionId, isComplete: true, outcomeType: "demo_booking", agentVersion: 1 });
      expect(second.capturedData).toEqual({ email: "ada@example.com" });
      expect(second.goalProgress.qualify?.status).toBe("achieved");
      expect(second.steps.filter((s) => s.kind === "tool").map((s) => s.name)).toEqual(["capture_field", "update_goal", "end_conversation"]);

      // Nothing real was created: no conversation, no stored trace, no lead.
      expect(await prisma.conversation.count({ where: { tenantId: t.tenantId } })).toBe(0);
      expect(await prisma.agentRunStep.count({ where: { tenantId: t.tenantId } })).toBe(0);
      const leads = await json<{ leads: unknown[] }>(await api(t.token, "/leads"));
      expect(leads.leads).toHaveLength(0);
      expect((await json<{ total: number }>(await api(t.token, "/conversations/stats"))).total).toBe(0);
    }, 60000);

    it("a new session starts a fresh conversation, and reset forgets one", async () => {
      const t = await register("sessions");
      const agent = await agentFor(t.token);
      const a = await json<Turn>(await simulate(t.token, agent.id, "ada@example.com"));
      expect(a.isComplete).toBe(true);
      const b = await json<Turn>(await simulate(t.token, agent.id, "Hello")); // no sessionId → new conversation, nothing captured
      expect(b.capturedData).toEqual({});
      expect((await api(t.token, `/agents/${agent.id}/simulate/${b.sessionId}`, { method: "DELETE" })).status).toBe(200);
      const c = await json<Turn>(await simulate(t.token, agent.id, "Hello", { sessionId: b.sessionId }));
      expect(c.capturedData).toEqual({});
    }, 60000);

    it("exercises CRM and calendar tools against a sandbox — no real connection needed, nothing real touched", async () => {
      const t = await register("sandbox");
      const agent = await agentFor(t.token, { requiredFields: [{ key: "email", label: "Email", type: "email", required: true }, { key: "fullName", label: "Full name", type: "text", required: true }] });
      const day = (n: number, h: number) => { const d = new Date(Date.now() + n * 86_400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
      const sandbox = { knownContacts: [{ email: "ada@example.com", firstName: "Ada" }], busy: [{ start: day(2, 10), end: day(2, 11) }] };

      const s1 = await json<Turn>(await simulate(t.token, agent.id, "my email is ada@example.com", { sandbox }));
      const lookup = await json<Turn>(await simulate(t.token, agent.id, "do you know me?", { sessionId: s1.sessionId, sandbox }));
      expect(lookup.reply).toContain("Welcome back");
      const free = await json<Turn>(await simulate(t.token, agent.id, `please book ${day(2, 14)}`, { sessionId: s1.sessionId, sandbox }));
      expect(free.reply).toContain("booked");
      const taken = await json<Turn>(await simulate(t.token, agent.id, `please book ${day(2, 10)}`, { sessionId: s1.sessionId, sandbox }));
      expect(taken.reply).toContain("isn't available");

      expect(await prisma.crmConnection.count({ where: { tenantId: t.tenantId } })).toBe(0);
      expect(await prisma.integration.count({ where: { tenantId: t.tenantId } })).toBe(0);
    }, 80000);

    it("is tenant-scoped and validates its input", async () => {
      const a = await register("scope-a");
      const b = await register("scope-b");
      const agent = await agentFor(a.token);
      expect((await simulate(b.token, agent.id, "hi")).status).toBe(404);
      expect((await api(b.token, `/agents/${agent.id}/simulate/abcdefgh`, { method: "DELETE" })).status).toBe(404);
      expect((await simulate(a.token, agent.id, "")).status).toBe(400);
      expect((await simulate(a.token, agent.id, "hi", { sessionId: "../etc" })).status).toBe(400);
    }, 60000);
  });

  describe("scenarios", () => {
    const happy = { name: "Happy path", turns: ["Hello", "ada@example.com"], expect: { completes: true, outcomeType: "demo_booking", capturedEquals: { email: "ada@example.com" }, toolsCalled: ["end_conversation"], goalsAchieved: ["qualify"], maxTurns: 2 } };
    const doomed = { name: "Impossible", turns: ["Hello"], expect: { completes: true } };

    it("validates scenario definitions", async () => {
      const t = await register("validate");
      const agent = await agentFor(t.token);
      const post = (body: unknown) => api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body });
      expect((await post({ name: "x", turns: [] })).status).toBe(400);
      expect((await post({ name: "x", turns: ["hi"], expect: { toolsCalled: ["rm_rf"] } })).status).toBe(400);
      expect((await post({ name: "x", turns: Array(21).fill("hi") })).status).toBe(400);
      expect((await post({ name: "ok", turns: ["hi"] })).status).toBe(201);
    }, 40000);

    it("saves, edits and deletes scenarios, scoped to the tenant", async () => {
      const a = await register("crud-a");
      const b = await register("crud-b");
      const agent = await agentFor(a.token);
      const created = await json<{ id: string }>(await api(a.token, `/agents/${agent.id}/scenarios`, { method: "POST", body: happy }));
      expect(await json<unknown[]>(await api(a.token, `/agents/${agent.id}/scenarios`))).toHaveLength(1);

      const patched = await json<{ name: string; expect: { completes: boolean } }>(await api(a.token, `/agents/${agent.id}/scenarios/${created.id}`, { method: "PATCH", body: { name: "Renamed", expect: { completes: false } } }));
      expect(patched).toMatchObject({ name: "Renamed", expect: { completes: false } });

      expect((await api(b.token, `/agents/${agent.id}/scenarios`)).status).toBe(404);
      expect((await api(b.token, `/agents/${agent.id}/scenarios/${created.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await api(a.token, `/agents/${agent.id}/scenarios/${created.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await json<unknown[]>(await api(a.token, `/agents/${agent.id}/scenarios`))).toHaveLength(0);
    }, 60000);

    it("runs the suite, grades each scenario, stores the runs, and tracks passing state per agent version", async () => {
      const t = await register("run");
      const agent = await agentFor(t.token);
      const mk = async (body: unknown) => json<{ id: string }>(await api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body }));
      const good = await mk(happy);
      const bad = await mk(doomed);

      expect((await json<{ notRun: number }>(await api(t.token, `/agents/${agent.id}/scenarios/status`))).notRun).toBe(2);

      const run = await json<{ agentVersion: number; variants: Array<{ label: string; passed: number; total: number }>; results: Array<{ scenarioId: string; passed: boolean; checks: Array<{ passed: boolean; detail: string }>; runId: string }> }>(
        await api(t.token, `/agents/${agent.id}/scenarios/run`, { method: "POST", body: {} }),
      );
      expect(run.variants).toEqual([expect.objectContaining({ label: "current", passed: 1, total: 2 })]);
      expect(run.results.find((r) => r.scenarioId === good.id)!.passed).toBe(true);
      const failed = run.results.find((r) => r.scenarioId === bad.id)!;
      expect(failed.passed).toBe(false);
      expect(failed.checks[0]).toMatchObject({ passed: false, detail: "it did not complete" });

      expect(await json(await api(t.token, `/agents/${agent.id}/scenarios/status`))).toEqual({ agentVersion: 1, total: 2, passing: 1, failing: 1, notRun: 0 });

      const stored = await json<{ passed: boolean; result: { transcript: Array<{ role: string; text: string }>; outcome: { completed: boolean }; steps: unknown[] } }>(
        await api(t.token, `/agents/${agent.id}/scenarios/runs/${run.results.find((r) => r.scenarioId === good.id)!.runId}`),
      );
      expect(stored.result.transcript[0]).toEqual({ role: "visitor", text: "Hello" });
      expect(stored.result.outcome.completed).toBe(true);
      expect(stored.result.steps.length).toBeGreaterThan(0);
      expect(await json<unknown[]>(await api(t.token, `/agents/${agent.id}/scenarios/runs`))).toHaveLength(2);

      // Changing the agent invalidates "passing": the new version hasn't been tested.
      await api(t.token, `/agents/${agent.id}`, { method: "PATCH", body: { script: "A different script" } });
      expect(await json(await api(t.token, `/agents/${agent.id}/scenarios/status`))).toEqual({ agentVersion: 2, total: 2, passing: 0, failing: 0, notRun: 2 });
      const listed = await json<Array<{ lastRun: { passed: boolean; onCurrentVersion: boolean } }>>(await api(t.token, `/agents/${agent.id}/scenarios`));
      expect(listed.every((s) => s.lastRun.onCurrentVersion === false)).toBe(true);

      // Run just one scenario by id.
      const one = await json<{ results: unknown[]; agentVersion: number }>(await api(t.token, `/agents/${agent.id}/scenarios/run`, { method: "POST", body: { scenarioIds: [good.id] } }));
      expect(one).toMatchObject({ agentVersion: 2, results: [expect.anything()] });
      expect((await json<{ passing: number; notRun: number }>(await api(t.token, `/agents/${agent.id}/scenarios/status`)))).toMatchObject({ passing: 1, notRun: 1 });

      // Real data is still untouched, and deleting a scenario keeps its run history.
      expect(await prisma.conversation.count({ where: { tenantId: t.tenantId } })).toBe(0);
      await api(t.token, `/agents/${agent.id}/scenarios/${good.id}`, { method: "DELETE" });
      expect((await prisma.scenarioRun.findMany({ where: { agentId: agent.id, scenarioId: null } })).length).toBeGreaterThan(0);
    }, 180000);

    it("proves a hard rule holds: the violating reply is blocked and never reaches the visitor", async () => {
      const t = await register("rules");
      const agent = await agentFor(t.token, { hardRules: [{ id: "no-refunds", text: "Never promise guaranteed refunds to customers", action: "block", severity: "high" }] });
      await api(t.token, `/agents/${agent.id}/scenarios`, {
        method: "POST",
        body: { name: "Refund bait", turns: ["Can I get a refund?"], expect: { replyNotContains: ["guaranteed refunds"], minBlockedViolations: 1, completes: false } },
      });
      const run = await json<{ variants: Array<{ passed: number; total: number }> }>(await api(t.token, `/agents/${agent.id}/scenarios/run`, { method: "POST", body: {} }));
      expect(run.variants[0]).toMatchObject({ passed: 1, total: 1 });
    }, 80000);

    it("refuses bad run requests", async () => {
      const t = await register("badrun");
      const other = await register("badrun-other");
      const agent = await agentFor(t.token);
      const otherAgent = await agentFor(other.token);
      const foreign = await json<{ id: string }>(await api(other.token, `/agents/${otherAgent.id}/scenarios`, { method: "POST", body: { name: "x", turns: ["hi"] } }));
      const run = (body: unknown) => api(t.token, `/agents/${agent.id}/scenarios/run`, { method: "POST", body });

      expect((await run({})).status).toBe(400); // no scenarios yet
      await api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body: { name: "x", turns: ["hi"] } });
      expect((await run({ scenarioIds: [foreign.id] })).status).toBe(404); // another tenant's scenario
      expect((await run({ variants: [{ label: "a" }, { label: "a" }] })).status).toBe(400);
      expect((await run({ variants: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] })).status).toBe(400);
    }, 80000);

    it("compares the same suite across models side by side, recording tokens and which key served each", async () => {
      const t = await register("compare");
      const cred = await json<{ id: string }>(await api(t.token, "/models/credentials", { method: "POST", body: { provider: "anthropic", label: "Mine", apiKey: "sk-good-compare" } }));
      const agent = await agentFor(t.token);
      await api(t.token, `/agents/${agent.id}/scenarios`, { method: "POST", body: happy });

      fake.calls = [];
      const run = await json<{ variants: Array<{ label: string; passed: number; total: number; inputTokens: number }>; results: Array<{ variant: string; runId: string }> }>(
        await api(t.token, `/agents/${agent.id}/scenarios/run`, {
          method: "POST",
          body: { variants: [{ label: "Shared default" }, { label: "My Opus", models: { default: { credentialId: cred.id, model: "big-model" } } }] },
        }),
      );
      expect(run.variants.map((v) => [v.label, v.passed, v.total])).toEqual([["Shared default", 1, 1], ["My Opus", 1, 1]]);
      // Only the second variant used the tenant's key and model — and it reported token usage.
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(fake.calls.every((c) => c.model === "big-model")).toBe(true);
      expect(run.variants[1]!.inputTokens).toBeGreaterThan(0);
      expect(run.variants[0]!.inputTokens).toBe(0); // the mock platform model reports no tokens

      const stored = await json<{ variant: string; result: { route: { keySource: string; model: string } } }>(await api(t.token, `/agents/${agent.id}/scenarios/runs/${run.results[1]!.runId}`));
      expect(stored).toMatchObject({ variant: "My Opus", result: { route: { keySource: "tenant", model: "big-model" } } });
      // A variant run never rewrites the agent: its spec has no model override.
      const after = await json<{ spec: { models: object } }>(await api(t.token, `/agents/${agent.id}`));
      expect(after.spec.models).toEqual({});
      // And "current"-variant status is untouched by a comparison run.
      expect((await json<{ notRun: number }>(await api(t.token, `/agents/${agent.id}/scenarios/status`))).notRun).toBe(1);
    }, 120000);
  });
});
