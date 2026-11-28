import { describe, expect, it } from "vitest";
import { AgentSpec } from "./agent-spec.js";
import { MODEL_CATALOG, MODEL_PROVIDER_KINDS, ModelConfig, presetModels } from "./models.js";

describe("model presets", () => {
  it("assigns a strong model to chat/judge and a fast one to extract/summarize for best_quality", () => {
    expect(presetModels("anthropic", "best_quality")).toEqual({
      chat: "claude-opus-5-5",
      judge: "claude-opus-5-5",
      extract: "claude-haiku-5-5",
      summarize: "claude-haiku-5-5",
    });
  });

  it("uses the fast model everywhere for lowest_cost", () => {
    expect(Object.values(presetModels("gemini", "lowest_cost")!)).toEqual(Array(4).fill("gemini-2.0-flash"));
  });

  it("falls back to the nearest tier when a provider lacks one (Groq has no balanced)", () => {
    expect(presetModels("groq", "balanced")!.chat).toBe("openai/gpt-oss-120b");
    expect(presetModels("groq", "lowest_cost")!.chat).toBe("openai/gpt-oss-20b");
  });

  it("has no presets for a custom endpoint", () => {
    expect(presetModels("openai_compatible", "best_quality")).toBeNull();
  });

  it("every catalogued provider yields every preset", () => {
    for (const p of MODEL_PROVIDER_KINDS.filter((k) => k !== "openai_compatible")) {
      expect(Object.keys(MODEL_CATALOG)).toContain(p);
      for (const preset of ["best_quality", "balanced", "lowest_cost"] as const) expect(presetModels(p, preset)).not.toBeNull();
    }
  });
});

describe("ModelConfig", () => {
  it("defaults to platform fallback allowed and no choices", () => {
    expect(ModelConfig.parse({})).toEqual({ allowPlatformFallback: true });
  });
  it("rejects a choice without a model", () => {
    expect(ModelConfig.safeParse({ chat: { credentialId: "c", model: "" } }).success).toBe(false);
  });
  it("is part of AgentSpec as an optional per-agent override", () => {
    expect(AgentSpec.parse({}).models).toEqual({});
    expect(AgentSpec.parse({ models: { chat: { credentialId: "c", model: "m" } } }).models.chat?.model).toBe("m");
  });
});

describe("voice models", async () => {
  const { ModelConfig, VOICE_PROVIDERS, VOICE_CATALOG, supportsVoiceRole } = await import("./models.js");
  const { AgentSpec } = await import("./agent-spec.js");

  it("stores speech-to-text and text-to-speech choices, with an optional voice", () => {
    const c = ModelConfig.parse({ stt: { credentialId: "k", model: "whisper-large-v3" }, tts: { credentialId: "k", model: "tts-1", voice: "nova" } });
    expect(c.stt).toEqual({ credentialId: "k", model: "whisper-large-v3" });
    expect(c.tts).toEqual({ credentialId: "k", model: "tts-1", voice: "nova" });
    expect(ModelConfig.safeParse({ tts: { credentialId: "k", model: "tts-1", voice: "" } }).success).toBe(false);
  });

  it("an agent can override voice too", () => {
    expect(AgentSpec.parse({ models: { tts: { credentialId: "k", model: "tts-1", voice: "echo" } } }).models.tts?.voice).toBe("echo");
  });

  it("knows which providers can do which voice job — Anthropic can do neither, Groq only listens, Gemini only speaks", () => {
    expect(supportsVoiceRole("anthropic", "stt")).toBe(false);
    expect(supportsVoiceRole("anthropic", "tts")).toBe(false);
    expect(supportsVoiceRole("groq", "stt")).toBe(true);
    expect(supportsVoiceRole("groq", "tts")).toBe(false);
    expect(supportsVoiceRole("gemini", "tts")).toBe(true);
    expect(supportsVoiceRole("gemini", "stt")).toBe(false);
    expect(VOICE_PROVIDERS.stt).toContain("openai_compatible");
  });

  it("only suggests models for providers that can do the job, and every TTS suggestion has a default voice", () => {
    for (const role of ["stt", "tts"] as const) {
      for (const provider of Object.keys(VOICE_CATALOG[role])) expect(supportsVoiceRole(provider as never, role)).toBe(true);
    }
    for (const models of Object.values(VOICE_CATALOG.tts)) for (const m of models!) expect(m.defaultVoice).toBeTruthy();
  });
});
