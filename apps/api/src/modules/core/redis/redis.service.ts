import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

/**
 * Shared Redis client. Two things it backs today: live-conversation session
 * state (packages/agent/conversation/conversation-session.store.ts) and the
 * BullMQ connection used by the pipeline queue/worker. One connection is
 * enough at this scale; split into separate clients if either side ever
 * needs distinct connection tuning.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL must be set");
    }
    this.client = new Redis(url, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
