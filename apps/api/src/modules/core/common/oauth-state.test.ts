import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { consumeOAuthState, issueOAuthState } from "./oauth-state.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: async (k: string, v: string) => void store.set(k, v),
      getdel: async (k: string) => {
        const v = store.get(k) ?? null;
        store.delete(k);
        return v;
      },
    } as unknown as Redis,
  };
}

describe("oauth state", () => {
  it("round-trips the tenant, once", async () => {
    const { redis } = fakeRedis();
    const state = await issueOAuthState(redis, "tenant_a", "hubspot");
    expect(state).not.toContain("tenant_a");
    await expect(consumeOAuthState(redis, state, "hubspot")).resolves.toBe("tenant_a");
    await expect(consumeOAuthState(redis, state, "hubspot")).rejects.toThrow(/invalid or has expired/);
  });

  it("rejects a raw tenant id, a missing state, and cross-provider reuse", async () => {
    const { redis } = fakeRedis();
    await expect(consumeOAuthState(redis, "tenant_a", "hubspot")).rejects.toThrow();
    await expect(consumeOAuthState(redis, undefined, "hubspot")).rejects.toThrow(/Missing/);
    const state = await issueOAuthState(redis, "tenant_a", "google_calendar");
    await expect(consumeOAuthState(redis, state, "hubspot")).rejects.toThrow();
  });
});
