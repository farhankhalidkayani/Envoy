import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "./gateway/agent.gateway.js";

interface Frame {
  type: string;
  [key: string]: unknown;
}

/**
 * End-to-end proof of the agentic runtime over the real HTTP + WebSocket
 * surface, with the deterministic mock provider (LLM_PROVIDER=mock): a
 * tool-using agent collects fields via capture_field, resolves goals via
 * update_goal, ends via end_conversation (gated by the harness), can hand
 * off to a human, still gets hard-rule enforcement, and leaves a trace.
 * Also covers agent config versioning.
 */
describe("agentic runtime (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = (await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: `Agentic ${label} ${suffix}`, email: `agentic-${label}-${suffix}@test.dev`, password: "hunter22" }),
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

  async function createAgent(token: string, body: Record<string, unknown>, live = true) {
    const res = await api(token, "/agents", { method: "POST", body });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as { id: string; publicToken: string };
    if (live) await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { status: "live" } });
    return agent;
  }

  /** Sends each visitor message in turn, waiting for the agent's reply (or completion) before the next. */
  function converse(agent: { id: string; publicToken: string }, userTurns: string[], opts: { expectComplete?: boolean } = {}): Promise<{ frames: Frame[]; replies: string[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
      const frames: Frame[] = [];
      const replies: string[] = [];
      let next = 0;
      const timer = setTimeout(() => { ws.close(); reject(new Error("conversation timed out")); }, 20000);
      const done = () => { clearTimeout(timer); ws.close(); resolve({ frames, replies }); };
      const sendNext = () => {
        if (next >= userTurns.length) {
          // session.completed follows the last agent.message only after the DB write + queue hand-off (slow on a remote DB), so wait for it when we expect it.
          const deadline = Date.now() + (opts.expectComplete ? 12000 : 500);
          const poll = () => (frames.some((f) => f.type === "session.completed") || Date.now() > deadline ? setTimeout(done, 100) : void setTimeout(poll, 100));
          poll();
          return;
        }
        ws.send(JSON.stringify({ type: "user.message", text: userTurns[next++] }));
      };
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string) as Frame;
        frames.push(msg);
        if (msg.type === "session.ready") sendNext();
        else if (msg.type === "agent.message") { replies.push(msg.text as string); setTimeout(() => { if (!frames.some((f) => f.type === "session.completed")) sendNext(); }, 150); }
        else if (msg.type === "session.completed") setTimeout(done, 100);
        else if (msg.type === "error" || msg.type === "locked") { clearTimeout(timer); ws.close(); reject(new Error(`gateway: ${String(msg.message ?? msg.type)}`)); }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket error")); });
    });
  }

  const fieldsSpec = [
    { key: "email", label: "Email", type: "email", required: true },
    { key: "plan", label: "Plan", type: "select", required: true, options: ["starter", "pro"] },
    { key: "fullName", label: "Full Name", type: "text", required: true },
  ];
  const agenticSpec = {
    persona: "Warm and brief.",
    goals: [{ id: "qualify", title: "Qualify the lead", successCriteria: "Email, plan and name are captured", priority: "primary" }],
    // The mock's "extract" pass treats any short text as a name; the loop's own tools are what's under test here.
    runtime: { mode: "agentic", extractionFallback: false },
  };

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

  it("runs a full tool-using conversation: capture → goal → end, with a stored trace", async () => {
    const { token, tenantId } = await register("flow");
    const agent = await createAgent(token, {
      name: "Agentic Bot",
      script: "Book demos.",
      requiredFields: fieldsSpec,
      spec: agenticSpec,
    });

    const { frames, replies } = await converse(agent, ["Hi, I need help", "ada@example.com", "pro please", "Ada Lovelace"], { expectComplete: true });

    expect(replies[0]).toContain("email");
    const completed = frames.find((f) => f.type === "session.completed")!;
    expect(completed).toMatchObject({
      outcomeType: "demo_booking",
      capturedData: { email: "ada@example.com", plan: "pro", fullName: "Ada Lovelace" },
    });
    expect(replies.at(-1)).toContain("Thanks");

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id }, orderBy: { createdAt: "desc" } });
    expect(conversation.status).toBe("completed");
    expect(conversation.agentVersion).toBe(1);
    expect(conversation.goalProgress).toMatchObject({ qualify: { status: "achieved" } });

    const trace = (await (await api(token, `/conversations/${conversation.id}/trace`)).json()) as Array<{ kind: string; name: string; turn: number; seq: number; error: string | null }>;
    const tools = trace.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(tools).toEqual(["capture_field", "capture_field", "capture_field", "update_goal", "end_conversation"]);
    expect(trace.every((s) => s.error === null)).toBe(true);
    expect(trace.map((s) => s.seq)).toEqual([...trace.map((s) => s.seq)].sort((a, b) => a - b)); // ordered
    expect(new Set(trace.map((s) => s.turn))).toEqual(new Set([1, 2, 3, 4]));

    // Another tenant cannot read this trace.
    const other = await register("flow-other");
    expect((await api(other.token, `/conversations/${conversation.id}/trace`)).status).toBe(404);

    // The visitor-facing transcript is clean: no tool calls or tool results leak into it.
    const stored = await prisma.conversation.findFirstOrThrow({ where: { id: conversation.id } });
    void tenantId;
    await new Promise((r) => setTimeout(r, 1500));
    const withTranscript = await prisma.conversation.findFirstOrThrow({ where: { id: stored.id } });
    if (withTranscript.transcriptText) {
      expect(withTranscript.transcriptText).not.toMatch(/capture_field|"ok":true|toolCall/);
      expect(withTranscript.transcriptText).toContain("Visitor: ada@example.com");
    }
  }, 40000);

  it("hands the visitor to a human when asked, recording the reason", async () => {
    const { token } = await register("handoff");
    const agent = await createAgent(token, { name: "H", requiredFields: fieldsSpec, spec: agenticSpec });
    const { frames } = await converse(agent, ["Hello", "Can I talk to a human please?"], { expectComplete: true });
    const completed = frames.find((f) => f.type === "session.completed")!;
    expect(completed).toBeTruthy();
    expect(completed.outcomeType).toBeUndefined();
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
    expect(conversation.handoffReason).toContain("human");
    expect(conversation.status).toBe("completed");
  }, 30000);

  it("does not hand off when the tenant disabled that tool", async () => {
    const { token } = await register("nohandoff");
    const agent = await createAgent(token, {
      name: "NH",
      requiredFields: fieldsSpec,
      spec: { ...agenticSpec, tools: [{ name: "handoff_to_human", enabled: false }] },
    });
    const { frames, replies } = await converse(agent, ["Can I talk to a human please?"]);
    expect(frames.some((f) => f.type === "session.completed")).toBe(false);
    expect(replies[0]).toContain("email"); // carries on collecting instead
  }, 30000);

  it("still blocks a hard-rule-violating reply in agentic mode, and logs it", async () => {
    const { token } = await register("rules");
    const agent = await createAgent(token, {
      name: "R",
      requiredFields: fieldsSpec,
      hardRules: [{ id: "no-guaranteed-refunds", text: "Never promise guaranteed refunds to customers", action: "block", severity: "high" }],
      spec: agenticSpec,
    });
    const { replies } = await converse(agent, ["Can I get a refund?"]);
    expect(replies[0]).not.toContain("guaranteed refunds");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
    expect((conversation.ruleViolationsBlocked as Array<{ ruleId: string }>)[0]?.ruleId).toBe("no-guaranteed-refunds");
    const steps = await prisma.agentRunStep.findMany({ where: { conversationId: conversation.id } });
    expect(steps.some((s) => s.kind === "judge")).toBe(true);
  }, 30000);

  it("leaves classic agents on the original path (no tools, no trace rows)", async () => {
    const { token } = await register("classic");
    const agent = await createAgent(token, { name: "C", requiredFields: fieldsSpec });
    await converse(agent, ["Hi"]);
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
    expect(await prisma.agentRunStep.count({ where: { conversationId: conversation.id } })).toBe(0);
  }, 30000);

  describe("CRM and calendar tools", () => {
    const toolFields = [
      { key: "email", label: "Email", type: "email", required: true },
      { key: "fullName", label: "Full Name", type: "text", required: true }, // never supplied, so the conversation stays open
    ];
    const optIn = [{ name: "lookup_crm_contact" }, { name: "check_calendar_availability" }, { name: "book_meeting" }];
    const day = (offset: number, hour: number) => {
      const d = new Date(Date.now() + offset * 86_400_000);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const script = [
      "my email is existing.ada@example.com",
      "do you know me?",
      "is anything available tomorrow?",
      `please book ${day(2, 14)}`, // free
      `please book ${day(2, 10)}`, // the mock calendar is busy 10:00-11:00 UTC every day
    ];

    async function tenantWith(connect: { crm: boolean; calendar: boolean }) {
      const t = await register("tools");
      // Connecting needs the per-user feature flags the admin console normally grants.
      await prisma.user.updateMany({ where: { tenantId: t.tenantId }, data: { featureAccess: { crm: true, integrations: true } } });
      if (connect.crm) expect((await api(t.token, "/crm/connect", { method: "POST" })).status).toBeLessThan(300);
      if (connect.calendar) expect((await api(t.token, "/integrations/calendar/connect", { method: "POST" })).status).toBeLessThan(300);
      return t;
    }
    const toolSteps = async (agentId: string) => {
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId } });
      return prisma.agentRunStep.findMany({ where: { conversationId: conversation.id, kind: "tool" }, orderBy: { seq: "asc" } });
    };

    it("looks up the visitor, checks availability, books a free slot and refuses a busy one", async () => {
      const t = await tenantWith({ crm: true, calendar: true });
      const agent = await createAgent(t.token, { name: "Tools", requiredFields: toolFields, spec: { ...agenticSpec, goals: [], tools: optIn } });
      const { replies } = await converse(agent, script);

      expect(replies[1]).toContain("Welcome back");
      expect(replies[2]).toContain("calendar");
      expect(replies[3]).toContain("booked");
      expect(replies[4]).toContain("isn't available");

      const steps = await toolSteps(agent.id);
      expect(steps.map((s) => s.name)).toEqual(["capture_field", "lookup_crm_contact", "check_calendar_availability", "book_meeting", "book_meeting"]);
      expect(steps[1]!.output).toEqual({ found: true, firstName: "Existing" });
      expect((steps[2]!.output as { busy: unknown[] }).busy.length).toBeGreaterThan(0);
      expect(steps[3]!.output).toMatchObject({ booked: true });
      expect(steps[3]!.error).toBeNull();
      expect(steps[4]!.error).toContain("no longer available");
    }, 60000);

    it("never offers the tools when the tenant has not opted in, even with both systems connected", async () => {
      const t = await tenantWith({ crm: true, calendar: true });
      const agent = await createAgent(t.token, { name: "NoOptIn", requiredFields: toolFields, spec: { ...agenticSpec, goals: [] } });
      const { replies } = await converse(agent, script.slice(0, 3));
      expect(replies[1]).not.toContain("Welcome back");
      expect((await toolSteps(agent.id)).map((s) => s.name).filter((n) => optIn.some((t) => t.name === n))).toEqual([]);
    }, 60000);

    it("does not offer tools whose system is not connected", async () => {
      const t = await tenantWith({ crm: false, calendar: false });
      const agent = await createAgent(t.token, { name: "NoConn", requiredFields: toolFields, spec: { ...agenticSpec, goals: [], tools: optIn } });
      await converse(agent, script.slice(0, 4));
      expect((await toolSteps(agent.id)).map((s) => s.name).filter((n) => optIn.some((t) => t.name === n))).toEqual([]);
    }, 60000);

    it("exposes only found + first name from a CRM lookup", async () => {
      const t = await tenantWith({ crm: true, calendar: false });
      const agent = await createAgent(t.token, { name: "Probe", requiredFields: toolFields, spec: { ...agenticSpec, goals: [], tools: optIn } });
      // Refusing an email the visitor never gave is covered in integration-tools.test.ts; here, the happy path must not leak other contact fields.
      await converse(agent, script.slice(0, 2));
      const lookup = (await toolSteps(agent.id)).find((s) => s.name === "lookup_crm_contact")!;
      expect(Object.keys(lookup.output as object).sort()).toEqual(["firstName", "found"]);
    }, 60000);
  });

  describe("spec validation and versioning", () => {
    it("rejects an invalid spec with 400", async () => {
      const { token } = await register("badspec");
      const res = await api(token, "/agents", { method: "POST", body: { name: "x", spec: { tools: [{ name: "capture_field", enabled: false }] } } });
      expect(res.status).toBe(400);
    });

    it("snapshots every configuration change, skips non-config edits, and restores as a new version", async () => {
      const { token } = await register("versions");
      const agent = await createAgent(token, { name: "V", script: "first script" }, false);
      const get = async () => (await (await api(token, `/agents/${agent.id}`)).json()) as { version: number; script: string; spec: { runtime: { mode: string } } };

      expect((await get()).version).toBe(1);

      await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { name: "Renamed", status: "live" } });
      expect((await get()).version).toBe(1); // name/status are not configuration

      await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { script: "second script", note: "tighten" } });
      await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { script: "second script" } }); // no-op edit
      expect(await get()).toMatchObject({ version: 2, script: "second script" });

      await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { spec: { runtime: { mode: "agentic" } } } });
      expect((await get()).spec.runtime.mode).toBe("agentic");

      const versions = (await (await api(token, `/agents/${agent.id}/versions`)).json()) as Array<{ version: number; note: string | null }>;
      expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
      expect(versions.find((v) => v.version === 2)?.note).toBe("tighten");

      const restored = await api(token, `/agents/${agent.id}/versions/1/restore`, { method: "POST" });
      expect(restored.status).toBe(201);
      expect(await get()).toMatchObject({ version: 4, script: "first script", spec: { runtime: { mode: "classic" } } });
      expect(((await (await api(token, `/agents/${agent.id}/versions`)).json()) as unknown[]).length).toBe(4);
    }, 40000);

    it("keeps versions tenant-scoped", async () => {
      const a = await register("scope-a");
      const b = await register("scope-b");
      const agent = await createAgent(a.token, { name: "S" }, false);
      expect((await api(b.token, `/agents/${agent.id}/versions`)).status).toBe(404);
      expect((await api(b.token, `/agents/${agent.id}/versions/1/restore`, { method: "POST" })).status).toBe(404);
    }, 30000);

    it("backfills a baseline version for agents created before versioning existed", async () => {
      const { token } = await register("legacy");
      const agent = await createAgent(token, { name: "L", script: "legacy script" }, false);
      await prisma.agentVersion.deleteMany({ where: { agentId: agent.id } }); // simulate a pre-versioning row
      await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { script: "new script" } });
      const versions = await prisma.agentVersion.findMany({ where: { agentId: agent.id }, orderBy: { version: "asc" } });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect((versions[0]!.snapshot as { script: string }).script).toBe("legacy script");
    }, 30000);
  });
});
