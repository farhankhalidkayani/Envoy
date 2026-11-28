import { z } from "zod";
import { API_TOKEN_SCOPES, type ApiTokenScope } from "./api-tokens.js";

/**
 * OAuth 2.1 (authorization code + PKCE) so an MCP client can connect by signing in, instead of the user pasting a
 * token. What it issues is an ordinary Envoy API token — same scopes, limits, audit and revocation — that is
 * short-lived and renewed with a rotating refresh token.
 */

export const OAUTH_ACCESS_TOKEN_TTL_SEC = 3600;
export const OAUTH_REFRESH_TOKEN_TTL_DAYS = 30;
export const OAUTH_CODE_TTL_SEC = 600;

/** What a connection gets if the client asks for nothing in particular: build and test, and ask for approval. */
export const OAUTH_DEFAULT_SCOPES: readonly ApiTokenScope[] = ["agents:read", "agents:write", "conversations:read", "models:read", "approvals:read", "approvals:write"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/**
 * Where a client may ask us to send the user back to: https anywhere, plain http only to this machine (desktop apps
 * listening on a local port), or an app's own URL scheme (e.g. `cursor://…`). Never a fragment, never credentials.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Splits an OAuth `scope` string. Unknown names are reported, not silently dropped, so the client learns its mistake. */
export function parseScope(scope: string | undefined | null): { scopes: ApiTokenScope[]; unknown: string[] } {
  const words = [...new Set((scope ?? "").split(/\s+/).filter(Boolean))];
  const known = new Set<string>(API_TOKEN_SCOPES);
  return { scopes: words.filter((w): w is ApiTokenScope => known.has(w)), unknown: words.filter((w) => !known.has(w)) };
}

/** RFC 7591 dynamic registration, public clients only (no secret: PKCE does that job). */
export const RegisterClientInput = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().max(2000).refine(isAllowedRedirectUri, "redirect URIs must be https, http on localhost, or an app's own scheme, with no fragment")).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});
export type RegisterClientInput = z.infer<typeof RegisterClientInput>;

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

/** The query the client sends the user's browser to the consent page with. */
export const AuthorizeRequest = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().regex(PKCE_VALUE, "code_challenge must be a base64url S256 value"),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(1000).optional(),
  scope: z.string().max(1000).optional(),
  resource: z.string().max(2000).optional(),
});
export type AuthorizeRequest = z.infer<typeof AuthorizeRequest>;

export const ApproveAuthorizationInput = AuthorizeRequest.extend({
  /** What the person actually ticked — may be narrower than what the client asked for, never wider than what exists. */
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
});
export type ApproveAuthorizationInput = z.infer<typeof ApproveAuthorizationInput>;

export const isValidPkceVerifier = (v: unknown): v is string => typeof v === "string" && PKCE_VALUE.test(v);
