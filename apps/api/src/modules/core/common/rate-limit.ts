import { HttpException, HttpStatus } from "@nestjs/common";
import type { Redis } from "ioredis";

/**
 * Fixed-window counter: at most `limit` hits per `windowSec` for `key`.
 * ponytail: fixed window allows a 2x burst across a window boundary; move to
 * a sliding window if that burst ever matters.
 */
export async function enforceRateLimit(redis: Redis, key: string, limit: number, windowSec: number) {
  const redisKey = `ratelimit:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSec);
  if (count > limit) {
    throw new HttpException("Too many requests — try again shortly", HttpStatus.TOO_MANY_REQUESTS);
  }
}
