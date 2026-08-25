import { Module } from "@nestjs/common";
import { GeminiTtsProvider } from "./gemini-tts.provider.js";
import { GroqWhisperProvider } from "./groq-whisper.provider.js";
import { MockSttProvider } from "./mock-stt.provider.js";
import { MockTtsProvider } from "./mock-tts.provider.js";
import type { SttProvider, TtsProvider } from "./types.js";

export const STT_PROVIDER = "STT_PROVIDER";
export const TTS_PROVIDER = "TTS_PROVIDER";

/**
 * Selects the active Stt/TtsProvider from STT_PROVIDER/TTS_PROVIDER env vars
 * (mock|groq for STT, mock|gemini for TTS). Defaults to "mock" for both so
 * `pnpm dev` and the e2e suite work with zero external API keys, mirroring
 * LlmProviderModule.
 */
@Module({
  providers: [
    {
      provide: STT_PROVIDER,
      useFactory: (): SttProvider => {
        const selected = process.env.STT_PROVIDER ?? "mock";
        switch (selected) {
          case "groq": {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) throw new Error("STT_PROVIDER=groq requires GROQ_API_KEY");
            return new GroqWhisperProvider(apiKey, process.env.GROQ_WHISPER_MODEL);
          }
          case "mock":
            return new MockSttProvider();
          default:
            throw new Error(`Unknown STT_PROVIDER "${selected}" (expected mock|groq)`);
        }
      },
    },
    {
      provide: TTS_PROVIDER,
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
  exports: [STT_PROVIDER, TTS_PROVIDER],
})
export class VoiceProviderModule {}
