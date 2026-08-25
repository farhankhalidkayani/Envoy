import { Injectable } from "@nestjs/common";
import type { SttProvider, SttTranscribeResult } from "./types.js";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
};

/**
 * Groq's OpenAI-compatible audio transcription endpoint —
 * https://console.groq.com/docs/speech-to-text. Code-complete against the
 * documented multipart shape, not exercised against a live account (no
 * GROQ_API_KEY available in this environment), same posture as GroqLlmProvider.
 */
@Injectable()
export class GroqWhisperProvider implements SttProvider {
  readonly name = "groq";

  constructor(private readonly apiKey: string, private readonly model = DEFAULT_MODEL) {}

  async transcribe(audioBase64: string, mimeType: string): Promise<SttTranscribeResult> {
    const bytes = Buffer.from(audioBase64, "base64");
    const extension = EXTENSION_BY_MIME_TYPE[mimeType] ?? "webm";
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: mimeType }), `audio.${extension}`);
    form.set("model", this.model);
    form.set("response_format", "json");

    const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Groq transcription API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { text?: string };
    return { text: data.text ?? "" };
  }
}
