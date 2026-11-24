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
