import type { LlmMessage } from "../agent/providers/llm/types.js";

export const SUMMARY_QUEUE_NAME = "conversation-summary";

export interface SummaryJobData {
  conversationId: string;
  messages: LlmMessage[];
}
