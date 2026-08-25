import type { HardRuleDef } from "@envoy/types";

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
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
   * The second enforcement layer: classifies a candidate reply against the
   * tenant's hard rules. Returns which rule (if any) is violated; the
   * caller looks up that rule's own `action` (block vs escalate) to decide
   * what happens next — the judge doesn't invent policy, it just reports.
   */
  judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict>;
}
