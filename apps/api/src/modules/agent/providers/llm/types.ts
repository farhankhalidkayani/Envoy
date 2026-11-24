import type { HardRuleDef } from "@envoy/types";

export type LlmRole = "system" | "user" | "assistant" | "tool";

/** A tool invocation the model asked for. `id` pairs it with the `tool` message that carries the result. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Only on assistant messages: the tools the model called (content may then be empty). */
  toolCalls?: LlmToolCall[];
  /** Only on tool messages: which call this result answers. */
  toolCallId?: string;
  toolName?: string;
}

/** What the model is shown about a tool; `parameters` is a JSON Schema object. */
export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolRequest {
  messages: LlmMessage[];
  /** Empty = plain completion (the loop passes none once it wants a final reply). */
  tools: LlmToolDef[];
  maxTokens?: number;
}

export interface LlmToolResult {
  /** Visible text, possibly empty when the model only called tools. */
  text: string;
  toolCalls: LlmToolCall[];
}

/**
 * `purpose` lets a provider specialize behavior per call-site without a
 * different interface per use case. Real providers (Groq/Gemini) ignore it —
 * the prompt itself carries the instructions. The mock provider switches its
 * scripted behavior on it, which is what makes the whole engine testable
 * without a live API key: 'chat' drives a deterministic field-collection
 * FSM, 'extract' does regex-based field extraction, 'summarize' returns a
 * templated summary.
 */
export type LlmPurpose = "chat" | "extract" | "summarize";

export interface LlmCompleteRequest {
  messages: LlmMessage[];
  purpose: LlmPurpose;
  maxTokens?: number;
}

export interface LlmCompleteResult {
  text: string;
}

export interface JudgeVerdict {
  violated: boolean;
  ruleId?: string;
  reason?: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
  /**
   * One model call with tools available — the primitive the agent loop
   * repeats. Same provider/key as `complete`; may return text, tool calls,
   * or both.
   */
  completeWithTools(req: LlmToolRequest): Promise<LlmToolResult>;
  /**
   * The second enforcement layer: classifies a candidate reply against the
   * tenant's hard rules. Returns which rule (if any) is violated; the
   * caller looks up that rule's own `action` (block vs escalate) to decide
   * what happens next — the judge doesn't invent policy, it just reports.
   */
  judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict>;
}
