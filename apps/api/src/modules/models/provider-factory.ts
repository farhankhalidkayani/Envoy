import { Injectable } from "@nestjs/common";
import type { ModelProviderKind } from "@envoy/types";
import { AnthropicLlmProvider } from "../agent/providers/llm/anthropic.provider.js";
import { GeminiLlmProvider } from "../agent/providers/llm/gemini.provider.js";
import { GroqLlmProvider } from "../agent/providers/llm/groq.provider.js";
import { CustomOpenAiLlmProvider, OpenAiLlmProvider } from "../agent/providers/llm/openai.provider.js";
import type { LlmProvider } from "../agent/providers/llm/types.js";
import { GeminiTtsProvider } from "../agent/providers/voice/gemini-tts.provider.js";
import { OpenAiTtsProvider } from "../agent/providers/voice/openai-tts.provider.js";
import { GROQ_API_BASE, OPENAI_API_BASE, TranscriptionSttProvider } from "../agent/providers/voice/transcription.provider.js";
import type { SttProvider, TtsProvider } from "../agent/providers/voice/types.js";

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

  createStt(kind: ModelProviderKind, apiKey: string, model: string, baseUrl?: string | null): SttProvider {
    switch (kind) {
      case "openai":
        return new TranscriptionSttProvider("openai", apiKey, model, baseUrl ?? OPENAI_API_BASE);
      case "groq":
        return new TranscriptionSttProvider("groq", apiKey, model, GROQ_API_BASE);
      case "openai_compatible":
        if (!baseUrl) throw new Error("A base URL is required for an OpenAI-compatible endpoint");
        return new TranscriptionSttProvider("openai_compatible", apiKey, model, baseUrl);
      default:
        throw new Error(`${kind} can't transcribe speech`);
    }
  }

  createTts(kind: ModelProviderKind, apiKey: string, model: string, voice?: string, baseUrl?: string | null): TtsProvider {
    switch (kind) {
      case "openai":
        return new OpenAiTtsProvider("openai", apiKey, model, voice, baseUrl ?? undefined);
      case "gemini":
        return new GeminiTtsProvider(apiKey, model, voice);
      case "openai_compatible":
        if (!baseUrl) throw new Error("A base URL is required for an OpenAI-compatible endpoint");
        return new OpenAiTtsProvider("openai_compatible", apiKey, model, voice, baseUrl);
      default:
        throw new Error(`${kind} can't generate speech`);
    }
  }
}
