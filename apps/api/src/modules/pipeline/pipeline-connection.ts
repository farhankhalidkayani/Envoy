import { Redis } from "ioredis";

/**
 * A dedicated Redis connection for BullMQ, separate from RedisService's
 * client (used for live conversation session state). BullMQ's Worker holds
 * a long-lived blocking connection (BRPOPLPUSH-style commands); sharing
 * that with ordinary GET/SET traffic risks stalling unrelated Redis calls.
 */
export function createPipelineRedisConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL must be set");
  }
  return new Redis(url, { maxRetriesPerRequest: null });
}
