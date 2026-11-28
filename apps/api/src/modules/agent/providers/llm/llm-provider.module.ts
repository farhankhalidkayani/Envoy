import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../core/prisma/prisma.module.js";
import { ModelResolver } from "../../../models/model-resolver.js";
import { ModelUsageRecorder } from "../../../models/model-usage.recorder.js";
import { ModelProviderFactory } from "../../../models/provider-factory.js";
import { RoutedLlmProvider } from "../../../models/routed-llm.provider.js";
import { GeminiLlmProvider } from "./gemini.provider.js";
import { GroqLlmProvider } from "./groq.provider.js";
import { MockLlmProvider } from "./mock.provider.js";
import type { LlmProvider } from "./types.js";

export const LLM_PROVIDER = "LLM_PROVIDER";
/** The platform's own shared model, chosen by env. What a tenant gets until they connect their own key. */
export const PLATFORM_LLM_PROVIDER = "PLATFORM_LLM_PROVIDER";

/**
 * Selects the active LlmProvider from LLM_PROVIDER env var (mock|groq|gemini).
 * Defaults to "mock" so `pnpm dev` works with zero external API keys — this
 * is what makes the agent engine's e2e test runnable in CI/anywhere without
 * secrets. Set LLM_PROVIDER=groq or =gemini plus the matching *_API_KEY to
 * use a real model.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ModelResolver,
    ModelProviderFactory,
    ModelUsageRecorder,
    {
      // What every call site injects: the platform model, routed per tenant (see models/routed-llm.provider.ts).
      provide: LLM_PROVIDER,
      useFactory: (platform: LlmProvider, resolver: ModelResolver, factory: ModelProviderFactory, usage: ModelUsageRecorder): LlmProvider =>
        new RoutedLlmProvider(platform, resolver, factory, usage),
      inject: [PLATFORM_LLM_PROVIDER, ModelResolver, ModelProviderFactory, ModelUsageRecorder],
    },
    {
      provide: PLATFORM_LLM_PROVIDER,
      useFactory: (): LlmProvider => {
        const selected = process.env.LLM_PROVIDER ?? "mock";
        switch (selected) {
          case "groq": {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) throw new Error("LLM_PROVIDER=groq requires GROQ_API_KEY");
            return new GroqLlmProvider(apiKey, process.env.GROQ_MODEL);
          }
          case "gemini": {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error("LLM_PROVIDER=gemini requires GEMINI_API_KEY");
            return new GeminiLlmProvider(apiKey, process.env.GEMINI_MODEL);
          }
          case "mock":
            return new MockLlmProvider();
          default:
            throw new Error(`Unknown LLM_PROVIDER "${selected}" (expected mock|groq|gemini)`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER, PLATFORM_LLM_PROVIDER, ModelResolver, ModelProviderFactory, ModelUsageRecorder],
})
export class LlmProviderModule {}
