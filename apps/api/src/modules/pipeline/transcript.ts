import type { LlmMessage } from "../agent/providers/llm/types.js";

/** For text conversations the message log IS the recording — see build plan §Recordings pipeline. */
export function assembleTranscript(messages: LlmMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Visitor" : "Agent"}: ${m.content}`)
    .join("\n");
}
