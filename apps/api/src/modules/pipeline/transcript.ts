import type { LlmMessage } from "../agent/providers/llm/types.js";

/** For text conversations the message log IS the recording — see build plan §Recordings pipeline. */
export function assembleTranscript(messages: LlmMessage[]): string {
  return messages
    // Tool-call turns carry no visitor-facing text (assistant content may be empty; tool results aren't speech).
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0)
    .map((m) => `${m.role === "user" ? "Visitor" : "Agent"}: ${m.content}`)
    .join("\n");
}
