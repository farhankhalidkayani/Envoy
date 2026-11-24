import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLlmProvider } from "../agent/providers/llm/mock.provider.js";
import { OpenAiCompatibleProvider } from "../agent/providers/llm/openai-compatible.provider.js";
import { CustomOpenAiLlmProvider } from "../agent/providers/llm/openai.provider.js";
import { LlmHttpError, type LlmProvider } from "../agent/providers/llm/types.js";
import { encryptToken } from "../crm/token-crypto.js";
import { runWithModelContext, type ModelContext } from "./model-context.js";
import { ModelResolver, type ModelTarget } from "./model-resolver.js";
import { describeProviderFailure } from "./models.service.js";
import { RoutedLlmProvider } from "./routed-llm.provider.js";

const REQ = { purpose: "chat" as const, messages: [{ role: "user" as const, content: "hi" }] };

function fakeProvider(name: string, behaviour: () => Promise<unknown> | unknown = () => undefined): LlmProvider & { calls: number } {
  const mock = new MockLlmProvider();
  const p = {
    name,
    model: `${name}-model`,
    calls: 0,
    async complete(r: typeof REQ) {
      p.calls++;
      await behaviour();
      return { ...(await mock.complete(r)), usage: { inputTokens: 5, outputTokens: 2 } };
    },
    async completeWithTools(r: Parameters<LlmProvider["completeWithTools"]>[0]) {
      p.calls++;
      await behaviour();
      return mock.completeWithTools(r);
    },
    judge: mock.judge.bind(mock),
  };
  return p as unknown as LlmProvider & { calls: number };
}

function setup(target: ModelTarget, tenantProvider?: LlmProvider) {
  const platform = fakeProvider("platform");
  const resolver = { resolve: vi.fn(async () => target), markInvalid: vi.fn(async () => {}), touch: vi.fn(async () => {}) } as unknown as ModelResolver;
  const factory = { create: vi.fn(() => tenantProvider) };
  const usage = { record: vi.fn() };
  const router = new RoutedLlmProvider(platform, resolver, factory as never, usage as never);
  const ctx: ModelContext = { tenantId: "t1" };
  const run = <T>(fn: () => Promise<T>) => runWithModelContext(ctx, fn);
  return { router, platform, resolver, factory, usage, ctx, run };
}
const tenantTarget = (over: Partial<Extract<ModelTarget, { kind: "tenant" }>> = {}): ModelTarget => ({
  kind: "tenant", credentialId: "c1", provider: "anthropic", model: "claude-x", apiKey: "sk-secret", baseUrl: null, allowFallback: true, ...over,
});

describe("RoutedLlmProvider", () => {
  it("is just the platform provider when there is no model context", async () => {
    const t = setup({ kind: "platform", allowFallback: true });
    await t.router.complete(REQ);
    expect(t.platform.calls).toBe(1);
    expect(t.resolver.resolve).not.toHaveBeenCalled();
    expect(t.usage.record).not.toHaveBeenCalled();
  });

  it("uses the platform provider and records platform usage when the tenant configured nothing", async () => {
    const t = setup({ kind: "platform", allowFallback: true });
    await t.run(() => t.router.complete(REQ));
    expect(t.platform.calls).toBe(1);
    expect(t.usage.record).toHaveBeenCalledWith(expect.objectContaining({ keySource: "platform", provider: "platform", ok: true, tenantId: "t1" }));
    expect(t.ctx.lastRoute).toMatchObject({ keySource: "platform" });
  });

  it("routes to the tenant's own key and model, recording tokens against their credential", async () => {
    const tenant = fakeProvider("anthropic");
    const t = setup(tenantTarget(), tenant);
    await t.run(() => t.router.complete(REQ));
    expect(t.factory.create).toHaveBeenCalledWith("anthropic", "sk-secret", "claude-x", null);
    expect(tenant.calls).toBe(1);
    expect(t.platform.calls).toBe(0);
    expect(t.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ keySource: "tenant", credentialId: "c1", model: "claude-x", usage: { inputTokens: 5, outputTokens: 2 }, ok: true }),
    );
    expect(t.ctx.lastRoute).toEqual({ provider: "anthropic", model: "claude-x", keySource: "tenant" });
  });

  it("maps each call type to its role", async () => {
    const tenant = fakeProvider("openai");
    const t = setup(tenantTarget(), tenant);
    await t.run(async () => {
      await t.router.complete({ ...REQ, purpose: "extract" });
      await t.router.complete({ ...REQ, purpose: "summarize" });
      await t.router.completeWithTools({ messages: REQ.messages, tools: [] });
      await t.router.judge("x", []);
    });
    expect((t.resolver.resolve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(["extract", "summarize", "chat", "judge"]);
  });

  it("marks a rejected key invalid and fails over to the platform when allowed", async () => {
    const rejected = fakeProvider("anthropic", () => { throw new LlmHttpError("anthropic", 401, "bad key"); });
    const t = setup(tenantTarget(), rejected);
    const result = await t.run(() => t.router.complete(REQ));
    expect(result.text).toBeTruthy();
    expect(t.resolver.markInvalid).toHaveBeenCalledWith(t.ctx, "c1", expect.stringContaining("401"));
    expect(t.platform.calls).toBe(1);
    expect(t.ctx.lastRoute).toMatchObject({ keySource: "platform", failedOver: true });
    expect(t.usage.record).toHaveBeenCalledWith(expect.objectContaining({ keySource: "tenant", ok: false }));
    expect(t.usage.record).toHaveBeenCalledWith(expect.objectContaining({ keySource: "platform", ok: true }));
  });

  it("fails over on quota, rate limit, provider outage and network errors, but not on a malformed request", async () => {
    for (const err of [new LlmHttpError("x", 429, ""), new LlmHttpError("x", 402, ""), new LlmHttpError("x", 503, ""), new Error("ECONNRESET")]) {
      const t = setup(tenantTarget(), fakeProvider("x", () => { throw err; }));
      await t.run(() => t.router.complete(REQ));
      expect(t.platform.calls).toBe(1);
      expect(t.resolver.markInvalid).not.toHaveBeenCalled(); // only 401/403 condemn a key
    }
    const t = setup(tenantTarget(), fakeProvider("x", () => { throw new LlmHttpError("x", 400, "bad request"); }));
    await expect(t.run(() => t.router.complete(REQ))).rejects.toThrow("400");
    expect(t.platform.calls).toBe(0);
  });

  it("surfaces the failure instead of falling back when the tenant disallowed the platform default", async () => {
    const t = setup(tenantTarget({ allowFallback: false }), fakeProvider("x", () => { throw new LlmHttpError("x", 429, "quota"); }));
    await expect(t.run(() => t.router.complete(REQ))).rejects.toThrow("429");
    expect(t.platform.calls).toBe(0);
  });

  it("refuses (rather than silently using the shared model) when a chosen key is unusable and fallback is off", async () => {
    const t = setup({ kind: "platform", reason: "The selected API key was rejected by its provider.", allowFallback: false });
    await expect(t.run(() => t.router.complete(REQ))).rejects.toThrow("rejected");
    expect(t.platform.calls).toBe(0);
  });

  it("falls back quietly when a chosen key is unusable and fallback is on", async () => {
    const t = setup({ kind: "platform", reason: "The selected API key no longer exists.", allowFallback: true });
    await t.run(() => t.router.complete(REQ));
    expect(t.platform.calls).toBe(1);
  });
});

describe("ModelResolver", () => {
  const key = encryptToken("sk-live-1234");
  function resolverFor(config: unknown, creds: Array<Record<string, unknown>>) {
    const prisma = {
      client: {
        tenant: { findUnique: async () => ({ modelConfig: config }) },
        modelCredential: { findMany: async () => creds, updateMany: async () => ({}) },
      },
    };
    return new ModelResolver(prisma as never);
  }
  const cred = (id: string, status = "active") => ({ id, provider: "anthropic", encryptedKey: key, baseUrl: null, status });
  const choice = (id: string, model: string) => ({ credentialId: id, model });

  it("resolves nothing configured to the platform default", async () => {
    expect(await resolverFor({}, []).resolve({ tenantId: "t" }, "chat")).toMatchObject({ kind: "platform" });
  });

  it("prefers a role's own choice over the workspace default, and decrypts the key", async () => {
    const r = resolverFor({ default: choice("a", "cheap"), chat: choice("b", "strong") }, [cred("a"), cred("b")]);
    expect(await r.resolve({ tenantId: "t" }, "chat")).toMatchObject({ kind: "tenant", credentialId: "b", model: "strong", apiKey: "sk-live-1234" });
    expect(await r.resolve({ tenantId: "t" }, "extract")).toMatchObject({ credentialId: "a", model: "cheap" });
  });

  it("lets an agent's override beat the workspace config, role then default", async () => {
    const r = resolverFor({ chat: choice("a", "workspace") }, [cred("a"), cred("b")]);
    expect(await r.resolve({ tenantId: "t", agentModels: { default: choice("b", "agent-default") } }, "chat")).toMatchObject({ credentialId: "b", model: "agent-default" });
    expect(await r.resolve({ tenantId: "t", agentModels: { chat: choice("b", "agent-chat"), default: choice("a", "x") } }, "chat")).toMatchObject({ model: "agent-chat" });
  });

  it("never resolves a credential that isn't this tenant's, even if an agent spec names it", async () => {
    const r = resolverFor({}, [cred("mine")]);
    const out = await r.resolve({ tenantId: "t", agentModels: { chat: choice("someone-elses", "m") } }, "chat");
    expect(out).toMatchObject({ kind: "platform", reason: expect.stringContaining("no longer exists") });
  });

  it("treats a rejected (invalid) key as unusable", async () => {
    const out = await resolverFor({ default: choice("a", "m") }, [cred("a", "invalid")]).resolve({ tenantId: "t" }, "chat");
    expect(out).toMatchObject({ kind: "platform", reason: expect.stringContaining("rejected") });
  });

  it("reports the tenant's fallback preference and reads config once per context", async () => {
    const findUnique = vi.fn(async () => ({ modelConfig: { allowPlatformFallback: false } }));
    const r = new ModelResolver({ client: { tenant: { findUnique }, modelCredential: { findMany: async () => [] } } } as never);
    const ctx: ModelContext = { tenantId: "t" };
    expect((await r.resolve(ctx, "chat")).allowFallback).toBe(false);
    await r.resolve(ctx, "judge");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI-compatible provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer key and model, and parses text and token usage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } })));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAiCompatibleProvider({ name: "openai", apiKey: "sk-abc", model: "gpt-x", url: "https://api.example/v1/chat/completions" });
    expect(await p.complete(REQ)).toEqual({ text: "hello", usage: { inputTokens: 11, outputTokens: 3 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-abc");
    expect(JSON.parse(init.body as string).model).toBe("gpt-x");
  });

  it("throws a typed error carrying the HTTP status, with no key in the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid api key", { status: 401 })));
    const p = new OpenAiCompatibleProvider({ name: "openai", apiKey: "sk-secret-key", model: "m", url: "https://api.example/v1/chat/completions" });
    const err = await p.complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("sk-secret-key");
  });

  it("blocks a custom endpoint that points at a private address (SSRF guard)", async () => {
    const p = new CustomOpenAiLlmProvider("k", "m", "http://127.0.0.1:11434/v1");
    await expect(p.complete(REQ)).rejects.toThrow(/private|reserved/);
  });
});

describe("describeProviderFailure", () => {
  it("gives actionable, key-free messages", () => {
    expect(describeProviderFailure(new LlmHttpError("x", 401, "sk-leaky"))).toContain("rejected this API key");
    expect(describeProviderFailure(new LlmHttpError("x", 401, "sk-leaky"))).not.toContain("sk-leaky");
    expect(describeProviderFailure(new LlmHttpError("x", 404, ""))).toContain("model");
    expect(describeProviderFailure(new LlmHttpError("x", 429, ""))).toContain("rate limit");
    expect(describeProviderFailure(new Error("getaddrinfo ENOTFOUND"))).toContain("reach");
  });
});
