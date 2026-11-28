import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../../app.module.js";
import { RedisService } from "../../redis/redis.service.js";

const RESOURCE = "http://localhost:4100/mcp";
const REDIRECT = "http://127.0.0.1:33418/callback";

describe("OAuth sign-in for MCP clients (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const tenants: string[] = [];

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `oauth-${label}-${suffix}@test.dev`;
    const reg = (await fetch(`${baseUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantName: `OAuth ${label} ${suffix}`, email, password: "hunter22" }) }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId, email };
  }
  const call = (token: string | null, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const form = (path: string, fields: Record<string, string | undefined>) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined) as [string, string][]).toString() });

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };
  async function newClient(name = "Claude", redirect = REDIRECT) {
    const res = await call(null, "/oauth/register", { method: "POST", body: { client_name: name, redirect_uris: [redirect] } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }
  const authQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz-123", resource: RESOURCE, ...extra,
  });
  /** Consent as the owner; returns the code from the redirect. */
  async function consent(jwt: string, clientId: string, challenge: string, scopes = ["agents:read", "agents:write"], extra: Record<string, string> = {}) {
    const res = await call(jwt, "/oauth/authorize", { method: "POST", body: { ...authQuery(clientId, challenge, extra), scopes } });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("xyz-123");
    return url.searchParams.get("code")!;
  }
  const exchange = (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
    form("/oauth/token", { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE, ...extra });
  type Grant = { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
  async function connect(jwt: string, scopes?: string[]) {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const code = await consent(jwt, clientId, challenge, scopes);
    const res = await exchange(clientId, code, verifier);
    expect(res.status).toBe(200);
    return { clientId, grant: (await res.json()) as Grant };
  }
  const refresh = (clientId: string, token: string, scope?: string) => form("/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token, scope });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string; error_description: string });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 40000);
  // Registration is rate-limited per address for an hour, and this suite registers many apps from one address.
  const clearLimits = async () => {
    const redis = app.get(RedisService).client;
    const keys = await redis.keys("ratelimit:oauth-*");
    if (keys.length) await redis.del(...keys);
  };
  beforeEach(clearLimits);
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.oAuthClient.deleteMany({ where: { redirectUris: { has: REDIRECT } } });
    await app.close();
  });

  it("publishes discovery metadata: code flow with S256 PKCE only, public clients, our scopes", async () => {
    const res = await call(null, "/.well-known/oauth-authorization-server");
    expect(await res.json()).toMatchObject({
      issuer: "http://localhost:4000",
      authorization_endpoint: "http://localhost:3001/oauth/authorize",
      token_endpoint: "http://localhost:4000/oauth/token",
      registration_endpoint: "http://localhost:4000/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: expect.arrayContaining(["agents:read", "approvals:write"]),
    });
  });

  describe("registering", () => {
    it("is open but rate-limited: 20 registrations an hour from one address", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await call(null, "/oauth/register", { method: "POST", body: { redirect_uris: [REDIRECT] } })).status);
      expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
      expect(statuses[20]).toBe(429);
      await clearLimits();
    }, 60000);

    it("registers a public client and refuses unsafe redirect URIs", async () => {
      const res = await call(null, "/oauth/register", { method: "POST", body: { client_name: "Cursor", redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"] } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ client_name: "Cursor", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
      for (const uri of ["http://evil.example.com/cb", "javascript:alert(1)", "https://a.example/cb#x"]) {
        const bad = await call(null, "/oauth/register", { method: "POST", body: { redirect_uris: [uri] } });
        expect(bad.status, uri).toBe(400);
        expect((await errorOf(bad)).error).toBe("invalid_client_metadata");
      }
    });
  });

  describe("the full sign-in", () => {
    it("consent → code → token, and the token works through the normal API with exactly the approved scopes", async () => {
      const t = await register("full");
      const clientId = await newClient("Claude Desktop");
      const { verifier, challenge } = pkce();

      const described = await call(t.jwt, `/oauth/authorize/describe?${new URLSearchParams(authQuery(clientId, challenge, { scope: "agents:read conversations:read made:up" }))}`);
      expect(await described.json()).toMatchObject({ client: { id: clientId, name: "Claude Desktop" }, redirectHost: "127.0.0.1:33418", requestedScopes: ["agents:read", "conversations:read"], unknownScopes: ["made:up"] });

      const code = await consent(t.jwt, clientId, challenge, ["agents:read"]); // the person grants less than asked
      const res = await exchange(clientId, code, verifier);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const grant = (await res.json()) as Grant;
      expect(grant).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "agents:read" });
      expect(grant.access_token).toMatch(/^envoy_sk_/);
      expect(grant.refresh_token).toMatch(/^envoy_rt_/);

      expect((await call(grant.access_token, "/agents")).status).toBe(200);
      expect((await call(grant.access_token, "/agents", { method: "POST", body: { name: "x" } })).status).toBe(403); // not granted
      expect((await call(grant.access_token, "/tokens")).status).toBe(403); // never, for any token
      expect((await call(grant.refresh_token, "/agents")).status).toBe(401); // a refresh token is not an access token

      const listed = (await (await call(t.jwt, "/tokens")).json()) as Array<{ name: string; connectedApp: boolean; expiresAt: string }>;
      expect(listed[0]).toMatchObject({ name: "Claude Desktop", connectedApp: true });
      expect(new Date(listed[0]!.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000); // shown as active for the refresh lifetime

      const audit = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: { startsWith: "oauth." } }, orderBy: { createdAt: "asc" } });
      expect(audit.map((a) => a.action)).toEqual(["oauth.authorized", "oauth.connected"]);
    }, 120000);

    it("declining sends the app an access_denied, and nothing is issued", async () => {
      const t = await register("deny");
      const clientId = await newClient();
      const res = await call(t.jwt, "/oauth/authorize/deny", { method: "POST", body: authQuery(clientId, pkce().challenge) });
      const url = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("state")).toBe("xyz-123");
      expect(await prisma.oAuthCode.count({ where: { tenantId: t.tenantId } })).toBe(0);
    }, 60000);
  });

  describe("what the consent step refuses", () => {
    it("never redirects for an unknown app or an unregistered return address — the person sees the error", async () => {
      const t = await register("noredirect");
      const clientId = await newClient();
      const { challenge } = pkce();
      const unknown = await call(t.jwt, `/oauth/authorize/describe?${new URLSearchParams(authQuery("nope", challenge))}`);
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: "invalid_client" });
      const elsewhere = await call(t.jwt, "/oauth/authorize", { method: "POST", body: { ...authQuery(clientId, challenge), redirect_uri: "https://attacker.example/steal", scopes: ["agents:read"] } });
      expect(elsewhere.status).toBe(400);
      expect(JSON.stringify(await elsewhere.json())).not.toContain("redirect_to");
    }, 60000);

    it("once the app is known, other problems go back to it as errors: missing PKCE, a different resource", async () => {
      const t = await register("badreq");
      const clientId = await newClient();
      const noPkce = await call(t.jwt, `/oauth/authorize/describe?${new URLSearchParams({ ...authQuery(clientId, "x"), code_challenge: "" })}`);
      const a = new URL(((await noPkce.json()) as { redirect_to: string }).redirect_to);
      expect(a.searchParams.get("error")).toBe("invalid_request");
      expect(a.searchParams.get("state")).toBe("xyz-123");
      const plain = await call(t.jwt, `/oauth/authorize/describe?${new URLSearchParams(authQuery(clientId, pkce().challenge, { code_challenge_method: "plain" }))}`);
      expect(new URL(((await plain.json()) as { redirect_to: string }).redirect_to).searchParams.get("error")).toBe("invalid_request");
      const other = await call(t.jwt, `/oauth/authorize/describe?${new URLSearchParams(authQuery(clientId, pkce().challenge, { resource: "https://other.example/api" }))}`);
      expect(new URL(((await other.json()) as { redirect_to: string }).redirect_to).searchParams.get("error")).toBe("invalid_target");
    }, 60000);

    it("must have at least one permission ticked", async () => {
      const t = await register("noscope");
      const res = await call(t.jwt, "/oauth/authorize", { method: "POST", body: { ...authQuery(await newClient(), pkce().challenge), scopes: [] } });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).error_description).toMatch(/at least one/);
    }, 60000);

    it("only the signed-in owner can approve — not staff, not an API token", async () => {
      const t = await register("whoapproves");
      const clientId = await newClient();
      const { grant } = await connect(t.jwt, ["agents:read", "agents:write", "approvals:write"]);
      expect((await call(grant.access_token, "/oauth/authorize", { method: "POST", body: { ...authQuery(clientId, pkce().challenge), scopes: ["agents:read"] } })).status).toBe(403);
      await prisma.user.update({ where: { email: t.email }, data: { role: "staff" } });
      const staff = (await (await call(null, "/auth/login", { method: "POST", body: { email: t.email, password: "hunter22" } })).json()) as { accessToken: string };
      expect((await call(staff.accessToken, "/oauth/authorize", { method: "POST", body: { ...authQuery(clientId, pkce().challenge), scopes: ["agents:read"] } })).status).toBe(403);
    }, 90000);
  });

  describe("exchanging the code", () => {
    it("needs the matching PKCE verifier", async () => {
      const t = await register("pkce");
      const clientId = await newClient();
      const { challenge } = pkce();
      const code = await consent(t.jwt, clientId, challenge);
      const res = await exchange(clientId, code, pkce().verifier);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("code_verifier") });
      const missing = await exchange(clientId, (await consent(t.jwt, clientId, challenge)), "");
      expect((await errorOf(missing)).error).toBe("invalid_request");
    }, 60000);

    it("is single use: a replayed code fails AND revokes the token from its first use", async () => {
      const t = await register("replay");
      const clientId = await newClient();
      const { verifier, challenge } = pkce();
      const code = await consent(t.jwt, clientId, challenge);
      const first = (await (await exchange(clientId, code, verifier)).json()) as Grant;
      expect((await call(first.access_token, "/agents")).status).toBe(200);
      const again = await exchange(clientId, code, verifier);
      expect((await errorOf(again)).error).toBe("invalid_grant");
      expect((await call(first.access_token, "/agents")).status).toBe(401);
    }, 60000);

    it("is bound to the client, the redirect URI and the resource it was issued for", async () => {
      const t = await register("binding");
      const clientId = await newClient();
      const otherClient = await newClient("Other");
      const { verifier, challenge } = pkce();
      expect((await errorOf(await exchange(otherClient, await consent(t.jwt, clientId, challenge), verifier))).error).toBe("invalid_grant");
      expect((await errorOf(await exchange(clientId, await consent(t.jwt, clientId, challenge), verifier, { redirect_uri: "http://127.0.0.1:1/other" }))).error).toBe("invalid_grant");
      expect((await errorOf(await exchange(clientId, await consent(t.jwt, clientId, challenge), verifier, { resource: "https://other.example" }))).error).toBe("invalid_target");
      expect((await errorOf(await exchange("ghost", "x", verifier))).error).toBe("invalid_client");
      expect((await errorOf(await form("/oauth/token", { grant_type: "password", client_id: clientId }))).error).toBe("unsupported_grant_type");
    }, 90000);

    it("expires after ten minutes", async () => {
      const t = await register("expiry");
      const clientId = await newClient();
      const { verifier, challenge } = pkce();
      const code = await consent(t.jwt, clientId, challenge);
      await prisma.oAuthCode.updateMany({ where: { tenantId: t.tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await errorOf(await exchange(clientId, code, verifier))).toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("expired") });
    }, 60000);
  });

  describe("staying connected", () => {
    it("refreshing rotates both tokens; the old access token stops working at once", async () => {
      const t = await register("refresh");
      const { clientId, grant } = await connect(t.jwt);
      const res = await refresh(clientId, grant.refresh_token);
      expect(res.status).toBe(200);
      const next = (await res.json()) as Grant;
      expect(next.access_token).not.toBe(grant.access_token);
      expect(next.refresh_token).not.toBe(grant.refresh_token);
      expect((await call(grant.access_token, "/agents")).status).toBe(401);
      expect((await call(next.access_token, "/agents")).status).toBe(200);
      expect(await prisma.apiToken.count({ where: { tenantId: t.tenantId } })).toBe(1); // one connection, not a pile of tokens
    }, 60000);

    it("an old refresh token coming back means it leaked: the whole connection is ended", async () => {
      const t = await register("rtreplay");
      const { clientId, grant } = await connect(t.jwt);
      const next = (await (await refresh(clientId, grant.refresh_token)).json()) as Grant;
      expect((await errorOf(await refresh(clientId, grant.refresh_token))).error).toBe("invalid_grant");
      expect((await call(next.access_token, "/agents")).status).toBe(401);
      expect((await errorOf(await refresh(clientId, next.refresh_token))).error).toBe("invalid_grant");
      expect(await prisma.auditLog.count({ where: { tenantId: t.tenantId, action: "oauth.refresh_replayed" } })).toBe(1);
    }, 60000);

    it("a refresh can narrow the scopes but never widen them, and only the same client can use it", async () => {
      const t = await register("rtscope");
      const { clientId, grant } = await connect(t.jwt, ["agents:read", "agents:write"]);
      expect((await errorOf(await refresh(await newClient("Thief"), grant.refresh_token))).error).toBe("invalid_grant");
      expect((await errorOf(await refresh(clientId, grant.refresh_token, "agents:read billing:read"))).error).toBe("invalid_scope");
      const narrowed = (await (await refresh(clientId, grant.refresh_token, "agents:read")).json()) as Grant;
      expect(narrowed.scope).toBe("agents:read");
      expect((await call(narrowed.access_token, "/agents", { method: "POST", body: { name: "x" } })).status).toBe(403);
    }, 90000);

    it("disconnecting in the portal ends it: the access token fails now, and it can't be refreshed", async () => {
      const t = await register("revoke");
      const { clientId, grant } = await connect(t.jwt);
      const id = ((await (await call(t.jwt, "/tokens")).json()) as Array<{ id: string }>)[0]!.id;
      expect((await call(t.jwt, `/tokens/${id}`, { method: "DELETE" })).status).toBe(200);
      expect((await call(grant.access_token, "/agents")).status).toBe(401);
      expect((await errorOf(await refresh(clientId, grant.refresh_token))).error_description).toMatch(/disconnected/);
    }, 60000);

    it("an expired refresh token means connecting again", async () => {
      const t = await register("rtexpiry");
      const { clientId, grant } = await connect(t.jwt);
      await prisma.apiToken.updateMany({ where: { tenantId: t.tenantId }, data: { refreshExpiresAt: new Date(Date.now() - 1000) } });
      expect((await errorOf(await refresh(clientId, grant.refresh_token))).error_description).toMatch(/expired/);
    }, 60000);

    it("the access token lasts an hour", async () => {
      const t = await register("attl");
      const { grant } = await connect(t.jwt);
      await prisma.apiToken.updateMany({ where: { tenantId: t.tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call(grant.access_token, "/agents")).status).toBe(401);
    }, 60000);
  });
});
