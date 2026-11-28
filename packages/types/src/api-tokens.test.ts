import { describe, expect, it } from "vitest";
import { API_TOKEN_SCOPES, CreateApiTokenInput, decideTokenAccess, forbiddenAgentEditForToken } from "./api-tokens.js";

const ALL = [...API_TOKEN_SCOPES];
const allow = (m: string, p: string, scopes: readonly string[] = ALL) => decideTokenAccess(m, p, scopes);
const denied = (m: string, p: string, scopes: readonly string[] = ALL) => {
  const r = allow(m, p, scopes);
  return r.allowed ? null : r.reason;
};

describe("decideTokenAccess", () => {
  it("maps reads and writes in each open area to the scope it needs", () => {
    expect(allow("GET", "/agents")).toEqual({ allowed: true, scope: "agents:read" });
    expect(allow("PATCH", "/agents/a1")).toEqual({ allowed: true, scope: "agents:write" });
    expect(allow("POST", "/agents/a1/simulate")).toEqual({ allowed: true, scope: "agents:write" });
    expect(allow("GET", "/agents/a1/improvement/metrics?days=7")).toEqual({ allowed: true, scope: "agents:read" });
    expect(allow("GET", "/conversations/c1/trace")).toEqual({ allowed: true, scope: "conversations:read" });
    expect(allow("GET", "/leads/stats")).toEqual({ allowed: true, scope: "conversations:read" });
    expect(allow("POST", "/forms")).toEqual({ allowed: true, scope: "forms:write" });
    expect(allow("GET", "/models/status")).toEqual({ allowed: true, scope: "models:read" });
    expect(allow("GET", "/crm/connection")).toEqual({ allowed: true, scope: "integrations:read" });
  });

  it("denies a request whose scope the token wasn't given", () => {
    expect(denied("PATCH", "/agents/a1", ["agents:read"])).toContain('"agents:write"');
    expect(denied("GET", "/conversations", ["agents:read"])).toContain('"conversations:read"');
    expect(denied("GET", "/agents", [])).toContain("agents:read");
  });

  it("closes everything outside the open areas, whatever the scopes", () => {
    for (const path of ["/auth/login", "/auth/register-admin", "/account", "/account/export", "/admin/tenants", "/tokens", "/webhooks/stripe", "/health", "/unknown", "/"]) {
      expect(denied("GET", path)).toContain("isn't available to API tokens");
    }
  });

  it("never lets a token change models, billing or integrations — those scopes can't even be granted", () => {
    expect(API_TOKEN_SCOPES).not.toContain("models:write");
    expect(denied("POST", "/models/credentials")).toContain("can't make changes to models");
    expect(denied("PUT", "/models/config")).toContain("can't make changes to models");
    expect(denied("DELETE", "/models/credentials/k1")).toContain("can't make changes");
    expect(denied("POST", "/billing/checkout")).toContain("can't make changes to billing");
    expect(denied("POST", "/crm/connect")).toContain("can't make changes to integrations");
    expect(denied("DELETE", "/integrations/calendar")).toContain("can't make changes to integrations");
  });

  it("lets a token ask for approval and see the answer, but never give it", () => {
    expect(allow("POST", "/approvals")).toEqual({ allowed: true, scope: "approvals:write" });
    expect(allow("GET", "/approvals")).toEqual({ allowed: true, scope: "approvals:read" });
    expect(allow("GET", "/approvals/a1")).toEqual({ allowed: true, scope: "approvals:read" });
    expect(denied("POST", "/approvals/a1/approve")).toContain("person");
    expect(denied("POST", "/approvals/a1/reject")).toContain("person");
    expect(denied("POST", "/approvals/a1/approve/")).toContain("person");
    expect(denied("POST", "/approvals", ["approvals:read"])).toContain('"approvals:write"');
  });

  it("keeps the actions that need a person out of reach even with full scopes", () => {
    expect(denied("POST", "/agents/a1/improvement/proposals/p1/approve")).toContain("decision for a person");
    expect(denied("POST", "/agents/a1/improvement/proposals/p1/reject")).toContain("decision for a person");
    expect(denied("POST", "/agents/a1/versions/3/restore")).toContain("hard rules");
    // …while the rest of the improvement flow is open.
    expect(allow("POST", "/agents/a1/improvement/proposals/p1/test").allowed).toBe(true);
    expect(allow("POST", "/agents/a1/improvement/insights/i1/propose").allowed).toBe(true);
  });

  it("is not fooled by trailing slashes, query strings or method case", () => {
    expect(allow("get", "/agents/?x=1").allowed).toBe(true);
    expect(denied("post", "/agents/a1/improvement/proposals/p1/approve/")).toContain("person");
    expect(denied("POST", "/agents/a1/improvement/proposals/p1/approve?x=/agents")).toContain("person");
  });

  it("does not confuse a path that merely contains an open area's name", () => {
    expect(denied("GET", "/admin/agents")).toContain("isn't available");
    expect(denied("GET", "/account/agents")).toContain("isn't available");
  });
});

describe("forbiddenAgentEditForToken", () => {
  it("allows ordinary configuration edits", () => {
    expect(forbiddenAgentEditForToken({})).toBeNull();
    expect(forbiddenAgentEditForToken({ status: "paused" })).toBeNull();
    expect(forbiddenAgentEditForToken({ spec: { tools: [{ name: "handoff_to_human", enabled: false }] } })).toBeNull();
    expect(forbiddenAgentEditForToken({ spec: { tools: [{ name: "book_meeting", enabled: false }] } })).toBeNull(); // turning one OFF is fine
  });
  it("allows re-sending an integration tool that is already on, but not newly enabling one", () => {
    const body = { spec: { tools: [{ name: "book_meeting", enabled: true }, { name: "lookup_crm_contact", enabled: true }] } };
    expect(forbiddenAgentEditForToken(body, new Set(["book_meeting", "lookup_crm_contact"]))).toBeNull();
    expect(forbiddenAgentEditForToken(body, new Set(["book_meeting"]))).toContain("CRM or calendar");
  });
  it("forbids changing hard rules, publishing, and switching on CRM/calendar tools", () => {
    expect(forbiddenAgentEditForToken({ hardRules: [] })).toContain("Hard rules");
    expect(forbiddenAgentEditForToken({ status: "live" })).toContain("Publishing");
    expect(forbiddenAgentEditForToken({ spec: { tools: [{ name: "lookup_crm_contact" }] } })).toContain("CRM or calendar");
    expect(forbiddenAgentEditForToken({ spec: { tools: [{ name: "book_meeting", enabled: true }] } })).toContain("CRM or calendar");
  });
});

describe("CreateApiTokenInput", () => {
  it("defaults to a 90 day expiry and needs at least one known scope", () => {
    expect(CreateApiTokenInput.parse({ name: "CI", scopes: ["agents:read"] }).expiresInDays).toBe(90);
    expect(CreateApiTokenInput.safeParse({ name: "CI", scopes: [] }).success).toBe(false);
    expect(CreateApiTokenInput.safeParse({ name: "CI", scopes: ["admin:*"] }).success).toBe(false);
    expect(CreateApiTokenInput.safeParse({ name: "CI", scopes: ["models:write"] }).success).toBe(false);
    expect(CreateApiTokenInput.safeParse({ name: "CI", scopes: ["agents:read"], expiresInDays: 0 }).success).toBe(false);
  });
});

describe("token self-check", () => {
  it("any token may read /token-info, whatever its scopes — and nothing else nearby", () => {
    expect(decideTokenAccess("GET", "/token-info", ["approvals:read"]).allowed).toBe(true);
    expect(decideTokenAccess("GET", "/token-info?x=1", ["agents:read"]).allowed).toBe(true);
    expect(decideTokenAccess("POST", "/token-info", ["agents:write"]).allowed).toBe(false);
    expect(decideTokenAccess("GET", "/token-info/extra", ["agents:read"]).allowed).toBe(false);
    expect(decideTokenAccess("GET", "/token-info", []).allowed).toBe(false);
  });
});
