import type { HardRuleDef } from "@envoy/types";
import { buildJudgeMessages, parseJudgeResponse } from "./judge-prompt.js";
import { parseAnthropicResponse, toAnthropicShape, toAnthropicTools } from "./tool-wire.js";
import {
  LlmHttpError,
  type JudgeVerdict,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmProvider,
  type LlmToolRequest,
  type LlmToolResult,
} from "./types.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Claude via the Messages API — https://docs.anthropic.com/en/api/messages. Code-complete against the documented shape; wire format is unit-tested, not live-tested. */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  private async call(req: LlmToolRequest): Promise<LlmToolResult> {
    const { system, messages } = toAnthropicShape(req.messages);
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 800,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      }),
    });
    if (!response.ok) throw new LlmHttpError("anthropic", response.status, await response.text().catch(() => ""));
    return parseAnthropicResponse((await response.json()) as Parameters<typeof parseAnthropicResponse>[0]);
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const { text, usage } = await this.call({ messages: req.messages, tools: [], maxTokens: req.maxTokens ?? 500 });
    return { text, usage };
  }

  completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    return this.call(req);
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
}
