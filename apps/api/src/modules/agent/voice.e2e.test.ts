import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "./gateway/agent.gateway.js";

/**
 * End-to-end proof of the Phase 3 voice pipeline, running against the real
 * HTTP+WS surface with the mock STT/TTS providers (STT_PROVIDER=mock,
 * TTS_PROVIDER=mock, apps/api/.env) — no external API key required. Voice
 * turns reuse the exact same ConversationEngineService as text turns (see
 * agent-engine.e2e.test.ts), so this only needs to prove the STT->engine->TTS
 * wiring itself: a `user.audio` message produces a `transcript`, a normal
 * `agent.message` reply, and an `agent.audio` reply with a real, non-empty
 * WAV payload.
 */
describe("voice pipeline (e2e)", () => {
  let app: INestApplication;
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
    const baseUrl = `http://localhost:${address.port}`;
    wsBase = `ws://localhost:${address.port}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantName: `Voice Test ${suffix}`,
        email: `voice-${suffix}@test.dev`,
        password: "hunter22",
      }),
    }).then((r) => r.json() as Promise<{ accessToken: string; user: { tenantId: string } }>);
    token = reg.accessToken;
    tenantId = reg.user.tenantId;

    const agent = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "Voice Test Bot",
        script: "You help visitors book a demo.",
        requiredFields: [{ key: "email", label: "Email", type: "email", required: true }],
        hardRules: [],
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

  it(
    "transcribes a user.audio message, replies with agent.message + agent.audio",
    async () => {
      const spokenText = "Hi there, my email is voice-e2e@example.com";
      const spokenBase64 = Buffer.from(spokenText, "utf8").toString("base64");

      const messages: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/agent/${agentId}`);
        const seen: Array<Record<string, unknown>> = [];
        const timeout = setTimeout(() => reject(new Error("timed out waiting for voice reply")), 15000);

        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "session.start", agentId, publicToken }));
        });

        ws.addEventListener("message", (event) => {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          seen.push(msg);
          if (msg.type === "session.ready") {
            ws.send(JSON.stringify({ type: "user.audio", chunk: spokenBase64, mimeType: "audio/webm" }));
          } else if (msg.type === "agent.audio") {
            clearTimeout(timeout);
            resolve(seen);
            ws.close();
          } else if (msg.type === "error" || msg.type === "locked") {
            clearTimeout(timeout);
            reject(new Error(`gateway said: ${(msg.message as string) ?? msg.type}`));
            ws.close();
          }
        });

        ws.addEventListener("error", (err) => {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error("WebSocket error"));
        });
      });

      const transcriptMsg = messages.find((m) => m.type === "transcript");
      expect(transcriptMsg?.text).toBe(spokenText);

      const agentMessage = messages.find((m) => m.type === "agent.message");
      expect(typeof agentMessage?.text).toBe("string");
      expect((agentMessage?.text as string).length).toBeGreaterThan(0);

      const agentAudio = messages.find((m) => m.type === "agent.audio");
      expect(agentAudio?.mimeType).toBe("audio/wav");
      expect(typeof agentAudio?.chunk).toBe("string");
      expect((agentAudio?.chunk as string).length).toBeGreaterThan(0);
    },
    15000,
  );
});
