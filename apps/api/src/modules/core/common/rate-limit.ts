import { HttpException, HttpStatus } from "@nestjs/common";
import type { Redis } from "ioredis";

/**
 * Sliding window via a Redis sorted set, scored by request timestamp: evict
 * anything older than the window, count what's left, and (if under the
 * limit) admit the new request — all in one Lua script so the
 * evict-count-admit sequence is atomic under concurrent callers. Unlike a
 * fixed window (INCR + EXPIRE), this can't be burst by hitting the limit
 * right at a window boundary and again right after it rolls over.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
end
return count + 1
`;
// Once count reaches the limit, further calls deliberately stop adding
// entries (the set caps out at `limit` members) — still returns a
// synthetic count+1 above the limit so blocking stays in effect for the
// rest of the window, but a client hammering the endpoint after being
// blocked can't grow the key without bound.

/** At most `limit` hits per `windowSec` for `key`, counted over a true sliding window. */
export async function enforceRateLimit(redis: Redis, key: string, limit: number, windowSec: number) {
  const redisKey = `ratelimit:${key}`;
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).slice(2)}`;
  const count = (await redis.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    redisKey,
    now,
    windowSec * 1000,
    limit,
    member,
  )) as number;
  if (count > limit) {
    throw new HttpException("Too many requests — try again shortly", HttpStatus.TOO_MANY_REQUESTS);
  }
}
