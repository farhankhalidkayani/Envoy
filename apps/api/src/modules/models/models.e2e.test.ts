import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../app.module.js";
import { AgentGateway } from "../agent/gateway/agent.gateway.js";
import { MockLlmProvider } from "../agent/providers/llm/mock.provider.js";
import { LlmHttpError, type LlmProvider } from "../agent/providers/llm/types.js";
import type { SttProvider, TtsProvider } from "../agent/providers/voice/types.js";
import { ModelProviderFactory } from "./provider-factory.js";

/**
 * A stand-in for real providers: behaves like the mock model, but records
 * every call (so tests can see which key/model served it) and rejects any key
 * starting with "bad" or listed in `revoked` — no network, no real keys.
 */
class FakeFactory extends ModelProviderFactory {
  calls: Array<{ kind: string; model: string; apiKey: string; purpose: string }> = [];
  revoked = new Set<string>();
  override create(kind: Parameters<ModelProviderFactory["create"]>[0], apiKey: string, model: string): LlmProvider {
    const mock = new MockLlmProvider();
    const guard = (purpose: string) => {
      this.calls.push({ kind, model, apiKey, purpose });
      if (apiKey.startsWith("bad") || this.revoked.has(apiKey)) throw new LlmHttpError(kind, 401, "invalid api key");
    };
    return {
      name: kind,
      model,
      complete: async (r) => { guard(r.purpose); return { ...(await mock.complete(r)), usage: { inputTokens: 10, outputTokens: 4 } }; },
      completeWithTools: async (r) => { guard("chat"); return { ...(await mock.completeWithTools(r)), usage: { inputTokens: 20, outputTokens: 6 } }; },
      judge: async (text, rules) => { guard("judge"); return mock.judge(text, rules); },
    };
  }

  voiceCalls: Array<{ role: "stt" | "tts"; kind: string; model: string; apiKey: string; voice?: string }> = [];
  override createStt(kind: Parameters<ModelProviderFactory["create"]>[0], apiKey: string, model: string): SttProvider {
    return {
      name: kind,
      transcribe: async (audio) => {
        this.voiceCalls.push({ role: "stt", kind, model, apiKey });
        if (apiKey.startsWith("bad") || this.revoked.has(apiKey)) throw new LlmHttpError(kind, 401, "invalid api key");
        return { text: `[${kind}] ${Buffer.from(audio, "base64").toString("utf8")}` };
      },
    };
  }
  override createTts(kind: Parameters<ModelProviderFactory["create"]>[0], apiKey: string, model: string, voice?: string): TtsProvider {
    return {
      name: kind,
      synthesize: async () => {
        this.voiceCalls.push({ role: "tts", kind, model, apiKey, voice });
        if (apiKey.startsWith("bad") || this.revoked.has(apiKey)) throw new LlmHttpError(kind, 401, "invalid api key");
        return { audioBase64: Buffer.from(`tenant-audio:${voice}`).toString("base64"), mimeType: "audio/wav" };
      },
    };
  }
}

describe("bring-your-own-model keys (e2e)", () => {
  const fake = new FakeFactory();
  let app: INestApplication;
  let baseUrl: string;
  let wsBase: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `byok-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: `BYOK ${label} ${suffix}`, email, password: "hunter22" }),
    }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { token: reg.accessToken, tenantId: reg.user.tenantId, email };
  }
  const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const json = async <T,>(res: Response) => (await res.json()) as T;

  async function addKey(token: string, apiKey = "sk-good-1111", provider = "anthropic", label = "Main") {
    const res = await api(token, "/models/credentials", { method: "POST", body: { provider, label, apiKey } });
    return { res, body: await json<{ id: string; last4: string }>(res.clone()) };
  }

  async function agentFor(token: string, spec: Record<string, unknown> = {}, hardRules: unknown[] = []) {
    const res = await api(token, "/agents", {
      method: "POST",
      body: {
        name: "BYOK Bot",
        hardRules,
        requiredFields: [{ key: "email", label: "Email", type: "email", required: true }],
        spec: { runtime: { mode: "agentic", extractionFallback: false }, ...spec },
      },
    });
    const agent = await json<{ id: string; publicToken: string }>(res);
    await api(token, `/agents/${agent.id}`, { method: "PATCH", body: { status: "live" } });
    return agent;
  }

  function converse(agent: { id: string; publicToken: string }, turns: string[], opts: { expectComplete?: boolean } = {}): Promise<{ replies: string[]; completed: boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
      const replies: string[] = [];
      let next = 0;
      let completed = false;
      const timer = setTimeout(() => { ws.close(); reject(new Error("timed out")); }, 25000);
      const finish = () => { clearTimeout(timer); ws.close(); resolve({ replies, completed }); };
      const send = () => {
        if (next < turns.length) return ws.send(JSON.stringify({ type: "user.message", text: turns[next++] }));
        // session.completed trails the last reply by a DB write + queue hand-off (slow on a remote DB): wait for it, briefly if we don't expect one.
        const deadline = Date.now() + (opts.expectComplete ? 15000 : 1200);
        const poll = () => (completed || Date.now() > deadline ? setTimeout(finish, 150) : void setTimeout(poll, 100));
        poll();
      };
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data as string) as { type: string; text?: string; message?: string };
        if (m.type === "session.ready") send();
        else if (m.type === "agent.message") { replies.push(m.text ?? ""); setTimeout(() => !completed && send(), 150); }
        else if (m.type === "session.completed") { completed = true; setTimeout(finish, 300); }
        else if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(`gateway: ${m.message}`)); }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ModelProviderFactory)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    wsBase = `ws://localhost:${port}`;
  }, 30000);

  beforeEach(() => { fake.calls = []; fake.voiceCalls = []; fake.revoked.clear(); });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await app.close();
  });

  describe("storing keys", () => {
    it("tests the key, encrypts it at rest, and never returns it", async () => {
      const t = await register("store");
      const { res, body } = await addKey(t.token, "sk-ant-secret-9876");
      expect(res.status).toBe(201);
      expect(body.last4).toBe("9876");
      expect(JSON.stringify(body)).not.toContain("secret");
      expect(fake.calls[0]).toMatchObject({ kind: "anthropic", apiKey: "sk-ant-secret-9876", purpose: "chat" }); // the connection test

      const row = await prisma.modelCredential.findFirstOrThrow({ where: { tenantId: t.tenantId } });
      expect(row.encryptedKey).not.toContain("secret");
      expect(row.encryptedKey.split(":")).toHaveLength(3); // iv:tag:ciphertext

      const listed = await json<Array<Record<string, unknown>>>(await api(t.token, "/models/credentials"));
      expect(listed).toHaveLength(1);
      expect(Object.keys(listed[0]!)).not.toContain("encryptedKey");
      expect(JSON.stringify(listed)).not.toContain("secret");
    }, 40000);

    it("rejects a key the provider refuses, storing nothing and not echoing the key", async () => {
      const t = await register("badkey");
      const { res } = await addKey(t.token, "bad-key-0000");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("rejected this API key");
      expect(text).not.toContain("bad-key-0000");
      expect(await prisma.modelCredential.count({ where: { tenantId: t.tenantId } })).toBe(0);
    }, 30000);

    it("requires a base URL for custom endpoints and blocks private addresses", async () => {
      const t = await register("custom");
      const noUrl = await api(t.token, "/models/credentials", { method: "POST", body: { provider: "openai_compatible", label: "x", apiKey: "sk-12345678", testModel: "m" } });
      expect(noUrl.status).toBe(400);
      const priv = await api(t.token, "/models/credentials", { method: "POST", body: { provider: "openai_compatible", label: "x", apiKey: "sk-12345678", baseUrl: "http://169.254.169.254/v1", testModel: "m" } });
      expect(priv.status).toBe(400);
      expect(await priv.text()).toContain("isn't allowed");
    }, 30000);

    it("is owner-only to change, but staff can see the status", async () => {
      const t = await register("roles");
      await prisma.user.update({ where: { email: t.email }, data: { role: "staff" } });
      const login = await json<{ accessToken: string }>(
        await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: t.email, password: "hunter22" }) }),
      );
      expect((await addKey(login.accessToken)).res.status).toBe(403);
      expect((await api(login.accessToken, "/models/config", { method: "PUT", body: {} })).status).toBe(403);
      expect((await api(login.accessToken, "/models/status")).status).toBe(200);
    }, 30000);

    it("keeps keys tenant-scoped", async () => {
      const a = await register("scope-a");
      const b = await register("scope-b");
      const { body } = await addKey(a.token);
      expect((await api(b.token, `/models/credentials/${body.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await api(b.token, `/models/credentials/${body.id}/test`, { method: "POST", body: {} })).status).toBe(404);
      expect(await json<unknown[]>(await api(b.token, "/models/credentials"))).toHaveLength(0);
      // …and can't be wired into another tenant's config.
      const cfg = await api(b.token, "/models/config", { method: "PUT", body: { chat: { credentialId: body.id, model: "m" } } });
      expect(cfg.status).toBe(400);
    }, 40000);
  });

  describe("serving conversations", () => {
    it("starts on the shared default, then serves every role from the tenant's own key once configured", async () => {
      const t = await register("serve");
      expect(await json<{ usingPlatformDefault: boolean }>(await api(t.token, "/models/status"))).toMatchObject({ usingPlatformDefault: true });

      const { body } = await addKey(t.token, "sk-good-2222");
      const cfg = await api(t.token, "/models/config", { method: "PUT", body: { chat: { credentialId: body.id, model: "claude-strong" }, default: { credentialId: body.id, model: "claude-fast" } } });
      expect(cfg.status).toBe(200);
      const status = await json<{ usingPlatformDefault: boolean; roles: Record<string, { source: string; model?: string }> }>(await api(t.token, "/models/status"));
      expect(status.usingPlatformDefault).toBe(false);
      expect(status.roles.chat).toMatchObject({ source: "tenant", model: "claude-strong" });
      expect(status.roles.summarize).toMatchObject({ source: "tenant", model: "claude-fast" });

      const agent = await agentFor(t.token);
      fake.calls = [];
      const { replies } = await converse(agent, ["Hello", "ada@example.com"]);
      expect(replies.length).toBeGreaterThan(0);

      const chatCalls = fake.calls.filter((c) => c.purpose === "chat");
      expect(chatCalls.length).toBeGreaterThan(0);
      expect(chatCalls.every((c) => c.model === "claude-strong" && c.apiKey === "sk-good-2222")).toBe(true);

      // Trace says which key answered; usage is billed to the tenant's credential with token counts.
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { agentId: agent.id } });
      const steps = await prisma.agentRunStep.findMany({ where: { conversationId: conversation.id, kind: "model" } });
      expect((steps[0]!.output as { route: unknown }).route).toMatchObject({ keySource: "tenant", provider: "anthropic", model: "claude-strong" });
      await new Promise((r) => setTimeout(r, 1500));
      const usage = await json<{ rows: Array<{ keySource: string; role: string; calls: number; inputTokens: number }> }>(await api(t.token, "/models/usage"));
      const chatRow = usage.rows.find((r) => r.role === "chat" && r.keySource === "tenant");
      expect(chatRow?.calls).toBeGreaterThan(0);
      expect(chatRow?.inputTokens).toBeGreaterThan(0);
      expect(usage.rows.some((r) => r.keySource === "platform")).toBe(false);
    }, 60000);

    it("honours a per-agent override over the workspace config", async () => {
      const t = await register("agentmodel");
      const { body } = await addKey(t.token, "sk-good-3333");
      await api(t.token, "/models/config", { method: "PUT", body: { default: { credentialId: body.id, model: "workspace-model" } } });
      const agent = await agentFor(t.token, { models: { chat: { credentialId: body.id, model: "agent-model" } } }, [
        { id: "no-promises", text: "Never promise anything unrealistic", action: "block", severity: "high" },
      ]);
      fake.calls = [];
      await converse(agent, ["Hello"]);
      expect(fake.calls.filter((c) => c.purpose === "chat").every((c) => c.model === "agent-model")).toBe(true);
      expect(fake.calls.some((c) => c.model === "workspace-model")).toBe(true); // judge/extract/summarize still use the workspace default
    }, 60000);

    it("fails over to the shared default when the tenant's key is revoked, and flags the key", async () => {
      const t = await register("failover");
      const { body } = await addKey(t.token, "sk-good-4444");
      await api(t.token, "/models/config", { method: "PUT", body: { default: { credentialId: body.id, model: "m" } } });
      const agent = await agentFor(t.token);
      fake.revoked.add("sk-good-4444"); // provider revokes the key after it was saved

      const { replies } = await converse(agent, ["Hello"]);
      expect(replies[0]).toBeTruthy(); // the visitor still got an answer

      const cred = await prisma.modelCredential.findUniqueOrThrow({ where: { id: body.id } });
      expect(cred.status).toBe("invalid");
      const status = await json<{ usingPlatformDefault: boolean; hasInvalidCredential: boolean }>(await api(t.token, "/models/status"));
      expect(status).toMatchObject({ usingPlatformDefault: true, hasInvalidCredential: true });
      await new Promise((r) => setTimeout(r, 1000));
      const usage = await json<{ rows: Array<{ keySource: string; failures: number }> }>(await api(t.token, "/models/usage"));
      expect(usage.rows.some((r) => r.keySource === "tenant" && r.failures > 0)).toBe(true);
      expect(usage.rows.some((r) => r.keySource === "platform")).toBe(true);
    }, 60000);

    it("errors instead of silently using the shared model when fallback is disabled", async () => {
      const t = await register("nofallback");
      const { body } = await addKey(t.token, "sk-good-5555");
      await api(t.token, "/models/config", { method: "PUT", body: { allowPlatformFallback: false, default: { credentialId: body.id, model: "m" } } });
      const agent = await agentFor(t.token);
      fake.revoked.add("sk-good-5555");
      // The agent loop turns a model failure into its safe fallback reply; nothing from the shared model is used.
      const { replies } = await converse(agent, ["Hello"]);
      expect(replies[0]).toContain("trouble");
      await new Promise((r) => setTimeout(r, 800));
      const usage = await json<{ rows: Array<{ keySource: string }> }>(await api(t.token, "/models/usage"));
      expect(usage.rows.some((r) => r.keySource === "platform")).toBe(false);
    }, 60000);

    it("ignores an agent spec that names another tenant's key and uses the shared default", async () => {
      const owner = await register("victim");
      const attacker = await register("attacker");
      const { body } = await addKey(owner.token, "sk-good-6666");
      const agent = await agentFor(attacker.token, { models: { default: { credentialId: body.id, model: "stolen" } } });
      fake.calls = [];
      const { replies } = await converse(agent, ["Hello"]);
      expect(replies[0]).toBeTruthy();
      expect(fake.calls.some((c) => c.apiKey === "sk-good-6666" && c.model === "stolen")).toBe(false);
    }, 60000);

    it("summarises completed conversations on the tenant's key", async () => {
      const t = await register("summary");
      const { body } = await addKey(t.token, "sk-good-7777");
      await api(t.token, "/models/config", { method: "PUT", body: { default: { credentialId: body.id, model: "summary-model" } } });
      const agent = await agentFor(t.token);
      fake.calls = [];
      const { completed } = await converse(agent, ["Hello", "ada@example.com"], { expectComplete: true });
      expect(completed).toBe(true);
      const deadline = Date.now() + 15000;
      while (!fake.calls.some((c) => c.purpose === "summarize") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
      expect(fake.calls.find((c) => c.purpose === "summarize")).toMatchObject({ apiKey: "sk-good-7777", model: "summary-model" });
    }, 80000);
  });


  describe("voice", () => {
    /** Speaks one utterance; returns what the visitor saw transcribed and the audio they got back. */
    function speak(agent: { id: string; publicToken: string }, said: string): Promise<{ transcript: string; audio: string }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/agent/${agent.id}`);
        let transcript = "";
        const timer = setTimeout(() => { ws.close(); reject(new Error("timed out")); }, 25000);
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken })));
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data as string) as { type: string; text?: string; chunk?: string; message?: string };
          if (m.type === "session.ready") ws.send(JSON.stringify({ type: "user.audio", chunk: Buffer.from(said).toString("base64"), mimeType: "audio/webm" }));
          else if (m.type === "transcript") transcript = m.text ?? "";
          else if (m.type === "agent.audio") { clearTimeout(timer); ws.close(); resolve({ transcript, audio: Buffer.from(m.chunk ?? "", "base64").toString("utf8") }); }
          else if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(`gateway: ${m.message}`)); }
        });
      });
    }
    const usageRows = async (token: string) => {
      await new Promise((r) => setTimeout(r, 1500));
      return (await json<{ rows: Array<{ keySource: string; role: string; provider: string; calls: number; failures: number }> }>(await api(token, "/models/usage"))).rows;
    };

    it("uses the platform voice until the workspace sets its own, and a chat `default` never takes over voice", async () => {
      const t = await register("voice-default");
      const { body } = await addKey(t.token, "sk-good-v1", "openai");
      await api(t.token, "/models/config", { method: "PUT", body: { default: { credentialId: body.id, model: "gpt-4.1" } } });
      const { transcript } = await speak(await agentFor(t.token), "hello there");
      expect(transcript).toBe("hello there"); // the platform (mock) voice, untouched
      expect(fake.voiceCalls).toEqual([]);
      expect(await json<{ voice: Record<string, { source: string }> }>(await api(t.token, "/models/status"))).toMatchObject({ voice: { stt: { source: "platform" }, tts: { source: "platform" } } });
    }, 90000);

    it("listens and speaks with the workspace's own keys, in the chosen voice, and records it as theirs", async () => {
      const t = await register("voice-byok");
      const groq = (await addKey(t.token, "gsk-good-v2", "groq", "Groq")).body;
      const openai = (await addKey(t.token, "sk-good-v3", "openai", "OpenAI")).body;
      const put = await api(t.token, "/models/config", { method: "PUT", body: { stt: { credentialId: groq.id, model: "whisper-large-v3" }, tts: { credentialId: openai.id, model: "gpt-4o-mini-tts", voice: "nova" } } });
      expect(put.status).toBe(200);
      expect(await json<{ voice: unknown }>(await api(t.token, "/models/status"))).toMatchObject({
        voice: { stt: { source: "tenant", provider: "groq", model: "whisper-large-v3" }, tts: { source: "tenant", provider: "openai", model: "gpt-4o-mini-tts", voice: "nova" } },
      });

      const out = await speak(await agentFor(t.token), "book me in");
      expect(out.transcript).toBe("[groq] book me in");
      expect(out.audio).toBe("tenant-audio:nova");
      expect(fake.voiceCalls).toEqual([
        { role: "stt", kind: "groq", model: "whisper-large-v3", apiKey: "gsk-good-v2" },
        { role: "tts", kind: "openai", model: "gpt-4o-mini-tts", apiKey: "sk-good-v3", voice: "nova" },
      ]);
      const rows = await usageRows(t.token);
      expect(rows.filter((r) => r.role === "stt" || r.role === "tts").map((r) => [r.role, r.keySource, r.provider]).sort()).toEqual([["stt", "tenant", "groq"], ["tts", "tenant", "openai"]]);
    }, 90000);

    it("an agent can use its own voice over the workspace's", async () => {
      const t = await register("voice-agent");
      const openai = (await addKey(t.token, "sk-good-v4", "openai")).body;
      await api(t.token, "/models/config", { method: "PUT", body: { tts: { credentialId: openai.id, model: "tts-1", voice: "alloy" } } });
      const agent = await agentFor(t.token, { models: { tts: { credentialId: openai.id, model: "gpt-4o-mini-tts", voice: "echo" } } });
      expect((await speak(agent, "hi")).audio).toBe("tenant-audio:echo");
      expect(fake.voiceCalls.find((c) => c.role === "tts")).toMatchObject({ model: "gpt-4o-mini-tts", voice: "echo" });
    }, 90000);

    it("a rejected voice key falls back to the platform voice, so the visitor still hears a reply, and the key is flagged", async () => {
      const t = await register("voice-failover");
      const openai = (await addKey(t.token, "sk-good-v5", "openai")).body;
      await api(t.token, "/models/config", { method: "PUT", body: { stt: { credentialId: openai.id, model: "gpt-4o-transcribe" }, tts: { credentialId: openai.id, model: "tts-1" } } });
      fake.revoked.add("sk-good-v5");
      const out = await speak(await agentFor(t.token), "still works");
      expect(out.transcript).toBe("still works"); // platform STT answered
      expect(out.audio).not.toContain("tenant-audio"); // platform TTS answered
      expect((await prisma.modelCredential.findUniqueOrThrow({ where: { id: openai.id } })).status).toBe("invalid");
      const rows = await usageRows(t.token);
      expect(rows.find((r) => r.role === "stt" && r.keySource === "tenant")?.failures).toBe(1);
      expect(rows.find((r) => r.role === "stt" && r.keySource === "platform")?.calls).toBe(1);
    }, 90000);

    it("with fallback off, a broken voice key is an error rather than a silent switch", async () => {
      const t = await register("voice-nofallback");
      const openai = (await addKey(t.token, "sk-good-v6", "openai")).body;
      await api(t.token, "/models/config", { method: "PUT", body: { stt: { credentialId: openai.id, model: "gpt-4o-transcribe" }, allowPlatformFallback: false } });
      fake.revoked.add("sk-good-v6");
      await expect(speak(await agentFor(t.token), "hello")).rejects.toThrow();
    }, 90000);

    it("refuses a key whose provider can't do that voice job", async () => {
      const t = await register("voice-invalid");
      const anthropic = (await addKey(t.token, "sk-ant-good", "anthropic")).body;
      const gemini = (await addKey(t.token, "gm-good-key", "gemini", "Gemini")).body;
      const groq = (await addKey(t.token, "gsk-good-v7", "groq", "Groq")).body;
      const put = (body: unknown) => api(t.token, "/models/config", { method: "PUT", body });
      for (const [body, word] of [
        [{ stt: { credentialId: anthropic.id, model: "x" } }, "speech-to-text: anthropic"],
        [{ tts: { credentialId: anthropic.id, model: "x" } }, "text-to-speech: anthropic"],
        [{ stt: { credentialId: gemini.id, model: "x" } }, "speech-to-text: gemini"],
        [{ tts: { credentialId: groq.id, model: "x" } }, "text-to-speech: groq"],
      ] as const) {
        const res = await put(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.text()).toContain(word);
      }
      expect((await put({ stt: { credentialId: groq.id, model: "whisper-large-v3" }, tts: { credentialId: gemini.id, model: "gemini-2.5-flash-preview-tts", voice: "Kore" } })).status).toBe(200);
    }, 90000);

    it("an agent override naming a key that can't do the job is ignored, not obeyed", async () => {
      const t = await register("voice-agentbad");
      const anthropic = (await addKey(t.token, "sk-ant-good-2", "anthropic")).body;
      const agent = await agentFor(t.token, { models: { stt: { credentialId: anthropic.id, model: "claude" } } });
      expect((await speak(agent, "hello")).transcript).toBe("hello"); // platform voice (fallback on by default)
      expect(fake.voiceCalls).toEqual([]);
    }, 90000);

    it("deleting a key removes it from the voice settings too", async () => {
      const t = await register("voice-delete");
      const openai = (await addKey(t.token, "sk-good-v8", "openai")).body;
      await api(t.token, "/models/config", { method: "PUT", body: { stt: { credentialId: openai.id, model: "gpt-4o-transcribe" }, tts: { credentialId: openai.id, model: "tts-1", voice: "alloy" } } });
      expect((await api(t.token, `/models/credentials/${openai.id}`, { method: "DELETE" })).status).toBeLessThan(300);
      const cfg = await json<Record<string, unknown>>(await api(t.token, "/models/config"));
      expect(cfg.stt).toBeUndefined();
      expect(cfg.tts).toBeUndefined();
    }, 90000);
  });

  describe("removing keys", () => {
    it("deleting a key clears it from the workspace config and returns the tenant to the shared default", async () => {
      const t = await register("delete");
      const { body } = await addKey(t.token, "sk-good-8888");
      await api(t.token, "/models/config", { method: "PUT", body: { default: { credentialId: body.id, model: "m" }, chat: { credentialId: body.id, model: "m2" } } });
      expect((await api(t.token, `/models/credentials/${body.id}`, { method: "DELETE" })).status).toBe(200);
      const cfg = await json<Record<string, unknown>>(await api(t.token, "/models/config"));
      expect(cfg.default).toBeUndefined();
      expect(cfg.chat).toBeUndefined();
      expect(await json<{ usingPlatformDefault: boolean }>(await api(t.token, "/models/status"))).toMatchObject({ usingPlatformDefault: true });
    }, 40000);

    it("re-testing a revoked key reports the failure and a healthy one restores it", async () => {
      const t = await register("retest");
      const { body } = await addKey(t.token, "sk-good-9999");
      fake.revoked.add("sk-good-9999");
      const bad = await json<{ ok: boolean; error?: string }>(await api(t.token, `/models/credentials/${body.id}/test`, { method: "POST", body: {} }));
      expect(bad).toMatchObject({ ok: false });
      expect((await prisma.modelCredential.findUniqueOrThrow({ where: { id: body.id } })).status).toBe("invalid");
      fake.revoked.clear();
      expect(await json<{ ok: boolean }>(await api(t.token, `/models/credentials/${body.id}/test`, { method: "POST", body: {} }))).toMatchObject({ ok: true });
      expect((await prisma.modelCredential.findUniqueOrThrow({ where: { id: body.id } })).status).toBe("active");
    }, 40000);

    it("audits key changes without recording the key", async () => {
      const t = await register("audit");
      const { body } = await addKey(t.token, "sk-good-0101");
      await api(t.token, `/models/credentials/${body.id}`, { method: "DELETE" });
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId } });
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["model_credential.added", "model_credential.removed"]));
      expect(JSON.stringify(logs)).not.toContain("sk-good-0101");
    }, 40000);
  });
});
