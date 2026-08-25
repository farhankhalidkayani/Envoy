import { Injectable } from "@nestjs/common";
import { RedisService } from "../../core/redis/redis.service.js";
import type { LlmMessage } from "../providers/llm/types.js";

const SESSION_TTL_SECONDS = 60 * 60 * 2; // 2h — generous for an active chat session

export interface ConversationSessionState {
  history: LlmMessage[];
  capturedData: Record<string, unknown>;
}

/**
 * Live, in-progress conversation state. Deliberately NOT in Postgres — this
 * is scratch state for a session that's still running; it's written to
 * Postgres once, at completion (Conversation.capturedData/transcriptText),
 * not on every turn. Keyed by conversationId with a TTL so an abandoned
 * session doesn't leak Redis memory forever.
 */
@Injectable()
export class ConversationSessionStore {
  constructor(private readonly redis: RedisService) {}

  private key(conversationId: string): string {
    return `session:${conversationId}`;
  }

  async init(conversationId: string): Promise<ConversationSessionState> {
    const state: ConversationSessionState = { history: [], capturedData: {} };
    await this.write(conversationId, state);
    return state;
  }

  async get(conversationId: string): Promise<ConversationSessionState | null> {
    const raw = await this.redis.client.get(this.key(conversationId));
    return raw ? (JSON.parse(raw) as ConversationSessionState) : null;
  }

  async write(conversationId: string, state: ConversationSessionState): Promise<void> {
    await this.redis.client.set(this.key(conversationId), JSON.stringify(state), "EX", SESSION_TTL_SECONDS);
  }

  async appendMessages(conversationId: string, messages: LlmMessage[]): Promise<ConversationSessionState> {
    const state = (await this.get(conversationId)) ?? { history: [], capturedData: {} };
    state.history.push(...messages);
    await this.write(conversationId, state);
    return state;
  }

  async setCapturedData(
    conversationId: string,
    capturedData: Record<string, unknown>,
  ): Promise<void> {
    const state = (await this.get(conversationId)) ?? { history: [], capturedData: {} };
    state.capturedData = capturedData;
    await this.write(conversationId, state);
  }

  async clear(conversationId: string): Promise<void> {
    await this.redis.client.del(this.key(conversationId));
  }
}
