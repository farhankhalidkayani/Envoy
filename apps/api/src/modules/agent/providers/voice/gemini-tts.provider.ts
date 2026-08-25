import { Injectable } from "@nestjs/common";
import { pcmToWav } from "./wav.js";
import type { TtsProvider, TtsSynthesizeResult } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
const PCM_SAMPLE_RATE = 24000;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;

/**
 * Gemini's speech-generation endpoint — generateContent with
 * responseModalities: ["AUDIO"]. Returns raw headerless 24kHz/16-bit/mono
 * PCM, which this wraps in a WAV header so the widget never needs to know
 * the difference between mock and real audio. Code-complete against the
 * documented shape, not exercised against a live account (no GEMINI_API_KEY
 * available in this environment) — same posture as GeminiLlmProvider. Exact
 * response field names should be re-confirmed against current docs before
 * relying on this in production.
 */
@Injectable()
export class GeminiTtsProvider implements TtsProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_MODEL,
    private readonly voiceName = DEFAULT_VOICE,
  ) {}

  async synthesize(text: string): Promise<TtsSynthesizeResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
          },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gemini TTS API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
    };
    const base64Pcm = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Pcm) {
      throw new Error("Gemini TTS API returned no audio data");
    }
    const pcm = Buffer.from(base64Pcm, "base64");
    const wav = pcmToWav(pcm, PCM_SAMPLE_RATE, PCM_BITS_PER_SAMPLE, PCM_CHANNELS);
    return { audioBase64: wav.toString("base64"), mimeType: "audio/wav" };
  }
}
