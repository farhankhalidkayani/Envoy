import { Injectable } from "@nestjs/common";
import type { HardRuleDef } from "@envoy/types";
import { buildJudgeMessages, parseJudgeResponse } from "./judge-prompt.js";
import { parseGeminiToolResponse, toGeminiToolShape, toGeminiTools } from "./tool-wire.js";
import {
  LlmHttpError,
  type JudgeVerdict,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmMessage,
  type LlmProvider,
  type LlmToolRequest,
  type LlmToolResult,
} from "./types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";

function geminiUsage(data: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }) {
  return data.usageMetadata
    ? { inputTokens: data.usageMetadata.promptTokenCount ?? 0, outputTokens: data.usageMetadata.candidatesTokenCount ?? 0 }
    : undefined;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/** https://ai.google.dev/api/generate-content — system messages go in a separate systemInstruction field. */
@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";

  constructor(private readonly apiKey: string, readonly model = DEFAULT_MODEL) {}

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
      throw new LlmHttpError("gemini", response.status, await response.text().catch(() => ""));
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { text, usage: geminiUsage(data) };
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const { systemText, contents } = toGeminiToolShape(req.messages);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        ...(req.tools.length > 0 ? { tools: toGeminiTools(req.tools) } : {}),
        generationConfig: { maxOutputTokens: req.maxTokens ?? 800 },
      }),
    });
    if (!response.ok) {
      throw new LlmHttpError("gemini", response.status, await response.text().catch(() => ""));
    }
    const data = (await response.json()) as Parameters<typeof parseGeminiToolResponse>[0] & { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    return { ...parseGeminiToolResponse(data), usage: geminiUsage(data) };
  }

  async judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict> {
    if (hardRules.length === 0) return { violated: false };
    const { text, usage } = await this.complete({
      purpose: "chat",
      messages: buildJudgeMessages(candidateText, hardRules),
      maxTokens: 200,
    });
    return { ...parseJudgeResponse(text), usage };
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
