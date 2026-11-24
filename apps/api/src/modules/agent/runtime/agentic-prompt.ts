import type { AgentSpec, GoalProgressMap } from "@envoy/types";
import type { AgentPromptConfig } from "../prompt/system-prompt.builder.js";
import {
  embedCapturedData,
  embedGoalProgress,
  embedGoals,
  embedRequiredFields,
} from "../providers/llm/prompt-markers.js";
import type { LlmMessage, LlmToolDef } from "../providers/llm/types.js";

/**
 * Stable prefix for the agentic runtime: identical for every conversation on
 * one agent version, so providers that cache prompt prefixes can. Anything
 * that changes per turn lives in buildAgenticVolatileContext.
 */
export function buildAgenticStablePrompt(config: AgentPromptConfig, spec: AgentSpec, tools: LlmToolDef[]): string {
  const rules =
    config.hardRules.length > 0
      ? config.hardRules
          .map((r) => `- ${r.text}${r.action === "block" ? " (never say this)" : " (flag for review if said)"}`)
          .join("\n")
      : "(none)";

  const fields =
    config.requiredFields.length > 0
      ? config.requiredFields
          .map((f) => {
            const base = `- ${f.key} (${f.label}, type: ${f.type}${f.required ? ", required" : ", optional"}${f.options ? `, options: ${f.options.join("/")}` : ""})`;
            return f.prompt ? `${base} — ${f.prompt}` : base;
          })
          .join("\n")
      : "(none)";

  const goals =
    spec.goals.length > 0
      ? spec.goals
          .map((g) => `- [${g.priority}] ${g.id}: ${g.title}. Success means: ${g.successCriteria}`)
          .join("\n")
      : "(none beyond helping the visitor)";

  const toolLines = tools.length > 0 ? tools.map((t) => `- ${t.name}: ${t.description}`).join("\n") : "(none)";

  return [
    "You are a helpful, concise customer-facing agent embedded on a business's website.",
    spec.persona ? `\nPersona and tone:\n${spec.persona}` : "",
    "",
    "Your instructions from the business:",
    config.script || "(no specific instructions provided — be generally helpful)",
    "",
    "Your goals, in priority order:",
    goals,
    "",
    "Information to collect from the visitor over the conversation, asking naturally rather than as an interrogation:",
    fields,
    "",
    "Hard rules — non-negotiable constraints on what you may say:",
    rules,
    "",
    "Tools you can call:",
    toolLines,
    "",
    "How to work:",
    "- Call capture_field as soon as the visitor gives you a value; do not wait to be asked twice.",
    "- You may call several tools in one step. Tool results tell you what is still missing — act on them.",
    "- When a tool reports an error, fix the problem (for example ask the visitor again); never mention tools or errors to the visitor.",
    "- Never invent information or claim you did something a tool did not confirm.",
    "- Finish with end_conversation only when everything required is captured and your goals are resolved, then write a brief closing message.",
    "- Every visitor-facing reply must be plain conversational text.",
    "",
    embedRequiredFields(config.requiredFields),
    embedGoals(spec.goals),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildAgenticVolatileContext(
  captured: Record<string, unknown>,
  progress: GoalProgressMap,
  missingRequired: string[],
): string {
  return [
    Object.keys(captured).length === 0
      ? "Nothing has been captured from this visitor yet."
      : `Already captured from this visitor: ${JSON.stringify(captured)}`,
    missingRequired.length > 0 ? `Still missing required fields: ${missingRequired.join(", ")}.` : "All required fields are captured.",
    Object.keys(progress).length > 0 ? `Goal progress: ${JSON.stringify(progress)}` : "No goal progress recorded yet.",
    embedCapturedData(captured),
    embedGoalProgress(progress),
  ].join("\n");
}

export function buildAgenticMessages(params: {
  config: AgentPromptConfig;
  spec: AgentSpec;
  tools: LlmToolDef[];
  captured: Record<string, unknown>;
  progress: GoalProgressMap;
  missingRequired: string[];
  history: LlmMessage[];
}): LlmMessage[] {
  return [
    { role: "system", content: buildAgenticStablePrompt(params.config, params.spec, params.tools) },
    { role: "system", content: buildAgenticVolatileContext(params.captured, params.progress, params.missingRequired) },
    ...params.history,
  ];
}
