import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "./gateway/agent.gateway.js";

async function waitForCondition<T>(
  fetchValue: () => Promise<T>,
  isReady: (value: T) => boolean,
  { timeoutMs = 8000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await fetchValue();
  while (!isReady(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await fetchValue();
  }
  return value;
}

/**
 * End-to-end proof of the Phase 1 conversation engine, running against the
 * real HTTP+WS surface with the mock LLM provider (LLM_PROVIDER=mock,
 * apps/api/.env) — no external API key required. Covers: field collection
 * across turns, per-field extraction/validation, completion-marker
 * detection, and — the graded metric — that a hard-rule violation is
 * caught and never reaches the visitor while still being logged.
 */
describe("agent conversation engine (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  let token: string;
  let agentId: string;
  let publicToken: string;
  let tenantId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
    wsBase = `ws://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: `Engine Test ${suffix}`,
        email: `engine-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => r.json() as Promise<{ accessToken: string; user: { tenantId: string } }>);
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "Engine Test Bot",
        script: "You help visitors book a demo.",
        requiredFields: [
          { key: "email", label: "Email", type: "email", required: true },
          { key: "plan", label: "Plan", type: "select", required: true, options: ["starter", "pro"] },
          { key: "fullName", label: "Full Name", type: "text", required: true },
        ],
        hardRules: [
          {
            id: "no-guaranteed-refunds",
            text: "Never promise guaranteed refunds to customers",
            action: "block",
            severity: "high",
          },
        ],
      }),
    }).then((r) => r.json() as Promise<{ id: string; publicToken: string }>);
    agentId = agent.id;
    publicToken = agent.publicToken;

    await fetch(`${baseUrl}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "live" }),
    });
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } }); // cascades agent + conversations
    await app.close();
  });

  function runConversation(
    userTurns: string[],
    opts: { waitForCompletion?: boolean } = {},
  ): Promise<{ transcript: Array<{ role: string; text: string }>; completed: unknown }> {
    const waitForCompletion = opts.waitForCompletion ?? true;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/agent/${agentId}`);
      const transcript: Array<{ role: string; text: string }> = [];
      let turnIndex = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("timed out waiting for a gateway response"));
        }
      }, 15000);

      const finish = (result: { transcript: typeof transcript; completed: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
        ws.close();
      };

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "session.start", agentId, publicToken }));
      });

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "session.ready") {
          ws.send(JSON.stringify({ type: "user.message", text: userTurns[turnIndex] }));
          transcript.push({ role: "user", text: userTurns[turnIndex]! });
          turnIndex++;
        } else if (msg.type === "agent.message") {
          transcript.push({ role: "agent", text: msg.text });
          if (turnIndex < userTurns.length) {
            ws.send(JSON.stringify({ type: "user.message", text: userTurns[turnIndex] }));
            transcript.push({ role: "user", text: userTurns[turnIndex]! });
            turnIndex++;
          } else if (!waitForCompletion) {
            finish({ transcript, completed: null });
          }
        } else if (msg.type === "session.completed") {
          finish({ transcript, completed: msg });
        } else if (msg.type === "error" || msg.type === "locked") {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`gateway said: ${msg.message ?? msg.type}`));
            ws.close();
          }
        }
      });

      ws.addEventListener("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error("WebSocket error"));
        }
      });
    });
  }

  it("collects required fields across turns and completes with the right outcome", async () => {
    const result = await runConversation([
      "Hi, I need help",
      "sure, ada@example.com",
      "I'll go with pro",
      "Ada Lovelace",
    ]);

    expect(result.completed).toMatchObject({
      type: "session.completed",
      outcomeType: "demo_booking",
      capturedData: { email: "ada@example.com", plan: "pro", fullName: "Ada Lovelace" },
    });

    // The pipeline worker runs asynchronously (see PipelineProcessor) — poll
    // rather than assert immediately, since completion doesn't wait on it.
    const stored = await waitForCondition(
      () =>
        prisma.conversation.findFirst({
          where: { agentId, status: "completed" },
          orderBy: { createdAt: "desc" },
        }),
      (c) => c?.transcriptText != null,
    );
    expect(stored?.transcriptText).toContain("Visitor: Hi, I need help");
    expect(stored?.aiSummary).toBeTruthy();
  });

  it("blocks a hard-rule-violating reply and delivers a safe one instead", async () => {
    const result = await runConversation(["Can I get a refund?"], { waitForCompletion: false });
    const deliveredReply = result.transcript.find((t) => t.role === "agent")?.text ?? "";

    expect(deliveredReply).not.toContain("guaranteed refunds");

    const stored = await prisma.conversation.findFirst({
      where: { agentId, status: { not: "completed" } },
      orderBy: { createdAt: "desc" },
    });
    const violations = stored?.ruleViolationsBlocked as Array<{ ruleId: string; candidateText: string }>;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe("no-guaranteed-refunds");
    expect(violations[0]?.candidateText).toContain("guaranteed refunds");
  });
});
