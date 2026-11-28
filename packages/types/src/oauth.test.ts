import { describe, expect, it } from "vitest";
import { AuthorizeRequest, RegisterClientInput, isAllowedRedirectUri, isValidPkceVerifier, parseScope } from "./oauth.js";

describe("redirect URIs", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", true],
    ["http://localhost:6274/oauth/callback", true],
    ["http://127.0.0.1:33418/cb", true],
    ["http://[::1]:8080/cb", true],
    ["cursor://anysphere.cursor-retrieval/oauth/callback", true],
    ["com.example.app:/oauth2redirect", true],
    ["http://evil.example.com/cb", false], // plain http only to this machine
    ["http://localhost.evil.com/cb", false],
    ["https://good.example.com/cb#frag", false],
    ["https://user:pass@good.example.com/cb", false],
    ["javascript:alert(1)", false],
    ["data:text/html,hi", false],
    ["file:///etc/passwd", false],
    ["not a url", false],
  ])("%s → %s", (uri, ok) => expect(isAllowedRedirectUri(uri)).toBe(ok));
});

describe("scopes", () => {
  it("keeps known scopes, reports unknown ones, ignores repeats and spacing", () => {
    expect(parseScope("  agents:read   agents:read approvals:write  ")).toEqual({ scopes: ["agents:read", "approvals:write"], unknown: [] });
    expect(parseScope("agents:read billing:write openid")).toEqual({ scopes: ["agents:read"], unknown: ["billing:write", "openid"] });
    expect(parseScope(undefined)).toEqual({ scopes: [], unknown: [] });
  });
});

describe("requests", () => {
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const base = { response_type: "code", client_id: "c1", redirect_uri: "https://x.example/cb", code_challenge: challenge, code_challenge_method: "S256" };

  it("requires PKCE with S256 — plain or missing is refused", () => {
    expect(AuthorizeRequest.safeParse(base).success).toBe(true);
    expect(AuthorizeRequest.safeParse({ ...base, code_challenge_method: "plain" }).success).toBe(false);
    expect(AuthorizeRequest.safeParse({ ...base, code_challenge: undefined }).success).toBe(false);
    expect(AuthorizeRequest.safeParse({ ...base, code_challenge: "short" }).success).toBe(false);
    expect(AuthorizeRequest.safeParse({ ...base, response_type: "token" }).success).toBe(false); // no implicit flow
  });

  it("verifiers are 43–128 unreserved characters", () => {
    expect(isValidPkceVerifier("a".repeat(43))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(42))).toBe(false);
    expect(isValidPkceVerifier("a".repeat(129))).toBe(false);
    expect(isValidPkceVerifier("a".repeat(42) + " ")).toBe(false);
    expect(isValidPkceVerifier(undefined)).toBe(false);
  });

  it("registers public clients only, with safe redirect URIs", () => {
    expect(RegisterClientInput.safeParse({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }).success).toBe(true);
    expect(RegisterClientInput.safeParse({ redirect_uris: [] }).success).toBe(false);
    expect(RegisterClientInput.safeParse({ redirect_uris: ["http://evil.com/cb"] }).success).toBe(false);
    expect(RegisterClientInput.safeParse({ redirect_uris: ["https://a/cb"], token_endpoint_auth_method: "client_secret_basic" }).success).toBe(false);
  });
});
