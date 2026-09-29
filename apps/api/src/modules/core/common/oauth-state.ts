import { BadRequestException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

const TTL_SECONDS = 600;

export type OAuthProvider = "hubspot" | "google_calendar";

/**
 * OAuth `state` must not be the tenant id: the callbacks are public, so a
 * guessable state lets anyone finish a flow with THEIR OWN HubSpot/Google
 * account against a victim tenant and redirect that tenant's leads to
 * themselves. Instead state is an unguessable nonce, stored server-side with
 * the tenant + provider that started the flow, valid once for 10 minutes.
 */
export async function issueOAuthState(redis: Redis, tenantId: string, provider: OAuthProvider): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await redis.set(`oauth-state:${state}`, JSON.stringify({ tenantId, provider }), "EX", TTL_SECONDS);
  return state;
}

/** Returns the tenant that started this flow; throws if the state is unknown, expired, reused, or for another provider. */
export async function consumeOAuthState(redis: Redis, state: string | undefined, provider: OAuthProvider): Promise<string> {
  if (!state) throw new BadRequestException("Missing OAuth state");
  const raw = await redis.getdel(`oauth-state:${state}`);
  const record = raw ? (JSON.parse(raw) as { tenantId: string; provider: OAuthProvider }) : null;
  if (!record || record.provider !== provider) {
    throw new BadRequestException("This connection link is invalid or has expired — start connecting again");
  }
  return record.tenantId;
}

/**
 * Where an OAuth callback sends the browser afterwards: back to the portal
 * page that started the flow, with the outcome in the query string (the
 * callback is a top-level navigation, so JSON would strand the user on the API).
 */
export function portalReturnUrl(path: string, outcome: { connected: string } | { error: string }): string {
  const url = new URL(path, process.env.PORTAL_URL ?? "http://localhost:3001");
  if ("connected" in outcome) url.searchParams.set("connected", outcome.connected);
  else url.searchParams.set("oauth_error", outcome.error.slice(0, 200));
  return url.toString();
}
