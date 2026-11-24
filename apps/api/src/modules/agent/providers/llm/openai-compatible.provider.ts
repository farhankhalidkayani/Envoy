import type { HardRuleDef } from "@envoy/types";
import { safeFetch } from "../../../core/common/safe-fetch.js";
import { buildJudgeMessages, parseJudgeResponse } from "./judge-prompt.js";
import { parseOpenAiToolResponse, toOpenAiMessages, toOpenAiTools } from "./tool-wire.js";
import {
  LlmHttpError,
  type JudgeVerdict,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmProvider,
  type LlmToolRequest,
  type LlmToolResult,
} from "./types.js";

export interface OpenAiCompatibleOptions {
  /** Shown in errors and traces, e.g. "openai", "groq". */
  name: string;
  apiKey: string;
  model: string;
  /** Full chat-completions URL. */
  url: string;
  /** Tenant-supplied URLs must go through the SSRF guard; first-party provider URLs need not. */
  guardUrl?: boolean;
}

interface OpenAiBody {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Any server speaking the OpenAI chat-completions protocol — OpenAI itself,
 * Groq, and the many self-hosted / gateway endpoints (vLLM, Ollama, Azure
 * OpenAI behind a proxy, OpenRouter…). Groq and OpenAI are thin subclasses
 * that only pin a URL.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(protected readonly opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ model: this.opts.model, ...body }),
    };
    const response = this.opts.guardUrl ? await safeFetch(this.opts.url, init) : await fetch(this.opts.url, init);
    if (!response.ok) throw new LlmHttpError(this.name, response.status, await response.text().catch(() => ""));
    return response.json();
  }

  private static usage(data: OpenAiBody) {
    return data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const data = (await this.post({ messages: req.messages, max_tokens: req.maxTokens ?? 500 })) as OpenAiBody;
    return { text: data.choices?.[0]?.message?.content ?? "", usage: OpenAiCompatibleProvider.usage(data) };
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const data = await this.post({
      messages: toOpenAiMessages(req.messages),
      ...(req.tools.length > 0 ? { tools: toOpenAiTools(req.tools), tool_choice: "auto" } : {}),
      max_tokens: req.maxTokens ?? 800,
    });
    return { ...parseOpenAiToolResponse(data as Parameters<typeof parseOpenAiToolResponse>[0]), usage: OpenAiCompatibleProvider.usage(data as OpenAiBody) };
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
