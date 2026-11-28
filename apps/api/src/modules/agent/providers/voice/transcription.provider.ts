import { LlmHttpError } from "../llm/types.js";
import type { SttProvider, SttTranscribeResult } from "./types.js";

export const GROQ_API_BASE = "https://api.groq.com/openai/v1";
export const OPENAI_API_BASE = "https://api.openai.com/v1";

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
};

/**
 * The OpenAI-style `/audio/transcriptions` endpoint, which OpenAI, Groq and most OpenAI-compatible servers share.
 * Code-complete against the documented multipart shape; not exercised against a live account here.
 */
export class TranscriptionSttProvider implements SttProvider {
  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async transcribe(audioBase64: string, mimeType: string): Promise<SttTranscribeResult> {
    const form = new FormData();
    form.set("file", new Blob([Buffer.from(audioBase64, "base64")], { type: mimeType }), `audio.${EXTENSION_BY_MIME_TYPE[mimeType] ?? "webm"}`);
    form.set("model", this.model);
    form.set("response_format", "json");

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) throw new LlmHttpError(this.name, response.status, await response.text());
    const data = (await response.json()) as { text?: string };
    return { text: data.text ?? "" };
  }
}
