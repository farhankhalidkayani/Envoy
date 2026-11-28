import { LlmHttpError } from "../llm/types.js";
import { OPENAI_API_BASE } from "./transcription.provider.js";
import type { TtsProvider, TtsSynthesizeResult } from "./types.js";

/** OpenAI's `/audio/speech` (also served by OpenAI-compatible servers). Asks for WAV so the widget plays it like every other voice. */
export class OpenAiTtsProvider implements TtsProvider {
  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice = "alloy",
    private readonly baseUrl = OPENAI_API_BASE,
  ) {}

  async synthesize(text: string): Promise<TtsSynthesizeResult> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text, voice: this.voice, response_format: "wav" }),
    });
    if (!response.ok) throw new LlmHttpError(this.name, response.status, await response.text());
    return { audioBase64: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: "audio/wav" };
  }
}
