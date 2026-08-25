import { Injectable } from "@nestjs/common";
import type { HardRuleDef } from "@envoy/types";
import { buildJudgeMessages, parseJudgeResponse } from "./judge-prompt.js";
import type {
  JudgeVerdict,
  LlmCompleteRequest,
  LlmCompleteResult,
  LlmMessage,
  LlmProvider,
} from "./types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/** https://ai.google.dev/api/generate-content — system messages go in a separate systemInstruction field. */
@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";

  constructor(private readonly apiKey: string, private readonly model = DEFAULT_MODEL) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const { systemText, contents } = this.toGeminiShape(req.messages);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: req.maxTokens ?? 500 },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { text };
  }

  async judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict> {
    if (hardRules.length === 0) return { violated: false };
    const { text } = await this.complete({
      purpose: "chat",
      messages: buildJudgeMessages(candidateText, hardRules),
      maxTokens: 200,
    });
    return parseJudgeResponse(text);
  }

  /** Gemini has no "system" role in `contents` — fold system messages into systemInstruction, map assistant→model. */
  private toGeminiShape(messages: LlmMessage[]): { systemText: string; contents: GeminiContent[] } {
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents: GeminiContent[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    return { systemText, contents };
  }
}
