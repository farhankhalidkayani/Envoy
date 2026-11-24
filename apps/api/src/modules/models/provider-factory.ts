import { Injectable } from "@nestjs/common";
import type { ModelProviderKind } from "@envoy/types";
import { AnthropicLlmProvider } from "../agent/providers/llm/anthropic.provider.js";
import { GeminiLlmProvider } from "../agent/providers/llm/gemini.provider.js";
import { GroqLlmProvider } from "../agent/providers/llm/groq.provider.js";
import { CustomOpenAiLlmProvider, OpenAiLlmProvider } from "../agent/providers/llm/openai.provider.js";
import type { LlmProvider } from "../agent/providers/llm/types.js";

/** Builds a provider client from a tenant's credential. Injectable so tests can substitute fakes (no network, no real keys). */
@Injectable()
export class ModelProviderFactory {
  create(kind: ModelProviderKind, apiKey: string, model: string, baseUrl?: string | null): LlmProvider {
    switch (kind) {
      case "anthropic":
        return new AnthropicLlmProvider(apiKey, model);
      case "openai":
        return new OpenAiLlmProvider(apiKey, model, baseUrl ?? undefined);
      case "gemini":
        return new GeminiLlmProvider(apiKey, model);
      case "groq":
        return new GroqLlmProvider(apiKey, model);
      case "openai_compatible":
        if (!baseUrl) throw new Error("A base URL is required for an OpenAI-compatible endpoint");
        return new CustomOpenAiLlmProvider(apiKey, model, baseUrl);
    }
  }
}
