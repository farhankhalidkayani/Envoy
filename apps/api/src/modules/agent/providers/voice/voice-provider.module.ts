import { Module } from "@nestjs/common";
import { ModelResolver } from "../../../models/model-resolver.js";
import { ModelUsageRecorder } from "../../../models/model-usage.recorder.js";
import { ModelProviderFactory } from "../../../models/provider-factory.js";
import { RoutedSttProvider, RoutedTtsProvider } from "../../../models/routed-voice.provider.js";
import { LlmProviderModule } from "../llm/llm-provider.module.js";
import { GeminiTtsProvider } from "./gemini-tts.provider.js";
import { GROQ_API_BASE, TranscriptionSttProvider } from "./transcription.provider.js";
import { MockSttProvider } from "./mock-stt.provider.js";
import { MockTtsProvider } from "./mock-tts.provider.js";
import type { SttProvider, TtsProvider } from "./types.js";

export const STT_PROVIDER = "STT_PROVIDER";
export const TTS_PROVIDER = "TTS_PROVIDER";
/** The platform's own voice, chosen by env: what a workspace gets until it sets its own speech key. */
export const PLATFORM_STT_PROVIDER = "PLATFORM_STT_PROVIDER";
export const PLATFORM_TTS_PROVIDER = "PLATFORM_TTS_PROVIDER";

/**
 * Selects the active Stt/TtsProvider from STT_PROVIDER/TTS_PROVIDER env vars
 * (mock|groq for STT, mock|gemini for TTS). Defaults to "mock" for both so
 * `pnpm dev` and the e2e suite work with zero external API keys, mirroring
 * LlmProviderModule.
 */
@Module({
  imports: [LlmProviderModule],
  providers: [
    {
      // What the gateway injects: the platform voice, routed per workspace/agent (see models/routed-voice.provider.ts).
      provide: STT_PROVIDER,
      useFactory: (platform: SttProvider, resolver: ModelResolver, factory: ModelProviderFactory, usage: ModelUsageRecorder): SttProvider => new RoutedSttProvider(platform, resolver, factory, usage),
      inject: [PLATFORM_STT_PROVIDER, ModelResolver, ModelProviderFactory, ModelUsageRecorder],
    },
    {
      provide: TTS_PROVIDER,
      useFactory: (platform: TtsProvider, resolver: ModelResolver, factory: ModelProviderFactory, usage: ModelUsageRecorder): TtsProvider => new RoutedTtsProvider(platform, resolver, factory, usage),
      inject: [PLATFORM_TTS_PROVIDER, ModelResolver, ModelProviderFactory, ModelUsageRecorder],
    },
    {
      provide: PLATFORM_STT_PROVIDER,
      useFactory: (): SttProvider => {
        const selected = process.env.STT_PROVIDER ?? "mock";
        switch (selected) {
          case "groq": {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) throw new Error("STT_PROVIDER=groq requires GROQ_API_KEY");
            return new TranscriptionSttProvider("groq", apiKey, process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo", GROQ_API_BASE);
          }
          case "mock":
            return new MockSttProvider();
          default:
            throw new Error(`Unknown STT_PROVIDER "${selected}" (expected mock|groq)`);
        }
      },
    },
    {
      provide: PLATFORM_TTS_PROVIDER,
      useFactory: (): TtsProvider => {
        const selected = process.env.TTS_PROVIDER ?? "mock";
        switch (selected) {
          case "gemini": {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error("TTS_PROVIDER=gemini requires GEMINI_API_KEY");
            return new GeminiTtsProvider(apiKey, process.env.GEMINI_TTS_MODEL, process.env.GEMINI_TTS_VOICE);
          }
          case "mock":
            return new MockTtsProvider();
          default:
            throw new Error(`Unknown TTS_PROVIDER "${selected}" (expected mock|gemini)`);
        }
      },
    },
  ],
  exports: [STT_PROVIDER, TTS_PROVIDER, PLATFORM_STT_PROVIDER, PLATFORM_TTS_PROVIDER],
})
export class VoiceProviderModule {}
