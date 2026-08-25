import type { HardRulesSpec, RequiredFieldsSpec } from "@envoy/types";
import { embedRequiredFields } from "../providers/llm/prompt-markers.js";
import type { LlmMessage } from "../providers/llm/types.js";

export interface AgentPromptConfig {
  script: string;
  requiredFields: RequiredFieldsSpec;
  hardRules: HardRulesSpec;
}

/**
 * The STABLE prefix — identical for every conversation this agent has.
 * Nothing here depends on conversation state, which is what makes it the
 * cacheable part (see the build plan's "prompt assembly built for caching").
 * Provider-level cache_control wiring is provider-specific (Groq/Gemini
 * don't expose the same mechanism Claude does) and isn't wired yet — this
 * split keeps that a config change later, not a restructure.
 */
export function buildStableSystemPrompt(config: AgentPromptConfig): string {
  const rulesList =
    config.hardRules.length > 0
      ? config.hardRules
          .map((r) => `- ${r.text}${r.action === "block" ? " (never say this)" : " (flag for review if said)"}`)
          .join("\n")
      : "(none)";

  const fieldsList =
    config.requiredFields.length > 0
      ? config.requiredFields
          .map((f) => `- ${f.key} (${f.label}, type: ${f.type}${f.required ? ", required" : ", optional"})`)
          .join("\n")
      : "(none)";

  return [
    "You are a helpful, concise customer-facing agent embedded on a business's website.",
    "",
    "Your instructions from the business:",
    config.script || "(no specific instructions provided — be generally helpful)",
    "",
    "You must collect the following information from the visitor over the course of the",
    "conversation, asking naturally rather than as an interrogation:",
    fieldsList,
    "",
    "Hard rules — these are non-negotiable constraints on what you may say:",
    rulesList,
    "",
    "Once you have collected everything you need and the conversation has reached its goal,",
    'end your reply with a completion marker: <<ENVOY_COMPLETE outcomeType="...">> where',
    "outcomeType is one of: demo_booking, order, complaint, appointment.",
    "",
    embedRequiredFields(config.requiredFields),
  ].join("\n");
}

/**
 * The VOLATILE suffix — changes every turn. Kept as a separate message so
 * the stable prefix above is byte-identical across turns (and conversations)
 * even as this grows.
 */
export function buildVolatileContext(capturedDataSoFar: Record<string, unknown>): string {
  const entries = Object.entries(capturedDataSoFar);
  if (entries.length === 0) return "Nothing has been captured from this visitor yet.";
  return `Already captured from this visitor: ${JSON.stringify(capturedDataSoFar)}`;
}

export function buildChatMessages(params: {
  config: AgentPromptConfig;
  capturedDataSoFar: Record<string, unknown>;
  history: LlmMessage[];
}): LlmMessage[] {
  return [
    { role: "system", content: buildStableSystemPrompt(params.config) },
    { role: "system", content: buildVolatileContext(params.capturedDataSoFar) },
    ...params.history,
  ];
}

/** Appended as a trailing system message on the one-shot retry after a blocked reply. */
export function buildRetryNoticeMessage(ruleText: string): LlmMessage {
  return {
    role: "system",
    content: `<<ENVOY_RETRY_AFTER_VIOLATION>> Your previous reply violated this rule: "${ruleText}". Regenerate your reply without violating it.`,
  };
}
