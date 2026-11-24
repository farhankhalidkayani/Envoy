import { Injectable } from "@nestjs/common";
import type { HardRuleDef } from "@envoy/types";
import { buildJudgeMessages, parseJudgeResponse } from "./judge-prompt.js";
import { parseOpenAiToolResponse, toOpenAiMessages, toOpenAiTools } from "./tool-wire.js";
import type {
  JudgeVerdict,
  LlmCompleteRequest,
  LlmCompleteResult,
  LlmProvider,
  LlmToolRequest,
  LlmToolResult,
} from "./types.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile was retired from Groq's catalog; openai/gpt-oss-120b
// is the current general-purpose chat model with comparable quality.
const DEFAULT_MODEL = "openai/gpt-oss-120b";

/** OpenAI-compatible chat completions API — https://console.groq.com/docs/api-reference */
@Injectable()
export class GroqLlmProvider implements LlmProvider {
  readonly name = "groq";

  constructor(private readonly apiKey: string, private readonly model = DEFAULT_MODEL) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 500,
      }),
    });
    if (!response.ok) {
      throw new Error(`Groq API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return { text: data.choices[0]?.message.content ?? "" };
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: toOpenAiMessages(req.messages),
        ...(req.tools.length > 0 ? { tools: toOpenAiTools(req.tools), tool_choice: "auto" } : {}),
        max_tokens: req.maxTokens ?? 800,
      }),
    });
    if (!response.ok) {
      throw new Error(`Groq API error ${response.status}: ${await response.text()}`);
    }
    return parseOpenAiToolResponse((await response.json()) as Parameters<typeof parseOpenAiToolResponse>[0]);
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
}
