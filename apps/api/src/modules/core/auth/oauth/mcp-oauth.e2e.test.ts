import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { createHttpServer } from "@envoy/mcp";
import { AppModule } from "../../../../app.module.js";
import { RedisService } from "../../redis/redis.service.js";

const REDIRECT = "http://127.0.0.1:47123/oauth/callback";

/**
 * The whole thing, as a real MCP client does it: the official SDK's OAuth client connects to the real MCP HTTP
 * server, gets a 401, discovers where to sign in, registers itself, sends the "browser" to the consent page (here:
 * the owner approving through the API, exactly as the portal page does), exchanges the code with PKCE, calls tools,
 * and later refreshes its token on its own.
 */
describe("an MCP client connecting by OAuth (e2e)", () => {
  let app: INestApplication;
  let mcp: Server;
  let apiUrl: string;
  let mcpUrl: string;
  const tenants: string[] = [];

  /** Stands in for the person's browser: when the app redirects them to consent, the owner approves (or not). */
  class TestProvider implements OAuthClientProvider {
    client?: OAuthClientInformationMixed;
    saved?: OAuthTokens;
    verifier = "";
    lastAuthorizeUrl?: URL;
    code?: string;
    constructor(private readonly ownerJwt: string, private readonly decision: { scopes?: string[]; deny?: boolean } = {}) {}
    get redirectUrl() { return REDIRECT; }
    get clientMetadata(): OAuthClientMetadata { return { client_name: "SDK Test Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
    clientInformation() { return this.client; }
    saveClientInformation(info: OAuthClientInformationMixed) { this.client = info; }
    tokens() { return this.saved; }
    saveTokens(tokens: OAuthTokens) { this.saved = tokens; }
    saveCodeVerifier(v: string) { this.verifier = v; }
    codeVerifier() { return this.verifier; }
    async redirectToAuthorization(url: URL) {
      this.lastAuthorizeUrl = url;
      const query = Object.fromEntries(url.searchParams);
      const path = this.decision.deny ? "/oauth/authorize/deny" : "/oauth/authorize";
      const res = await fetch(`${apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.ownerJwt}` }, body: JSON.stringify({ ...query, scopes: this.decision.scopes ?? ["agents:read", "agents:write"] }) });
      const back = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
      this.code = back.searchParams.get("code") ?? undefined;
    }
  }

  async function register(label: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const reg = (await fetch(`${apiUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantName: `MCP OAuth ${label} ${suffix}`, email: `mcpoauth-${label}-${suffix}@test.dev`, password: "hunter22" }) }).then((r) => r.json())) as { accessToken: string; user: { tenantId: string } };
    tenants.push(reg.user.tenantId);
    return { jwt: reg.accessToken, tenantId: reg.user.tenantId };
  }

  /** Connect the way a real client does: try, get sent to sign in, finish with the code, connect again. */
  async function connect(provider: TestProvider) {
    const first = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
    await expect(new Client({ name: "sdk", version: "0" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    if (!provider.code) return null;
    await first.finishAuth(provider.code);
    const client = new Client({ name: "sdk", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }));
    return client;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    apiUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
    mcp = createHttpServer(apiUrl).listen(0);
    await once(mcp, "listening");
    mcpUrl = `http://localhost:${(mcp.address() as AddressInfo).port}/mcp`;
    // The API reads its public URLs per request: point them at this test's servers.
    process.env.PUBLIC_API_URL = apiUrl;
    process.env.MCP_PUBLIC_URL = mcpUrl;
    const redis = app.get(RedisService).client;
    const keys = await redis.keys("ratelimit:oauth-*");
    if (keys.length) await redis.del(...keys);
  }, 40000);
  afterAll(async () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.MCP_PUBLIC_URL;
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.oAuthClient.deleteMany({ where: { name: "SDK Test Client" } });
    mcp.close();
    await app.close();
  });

  it("discovers, registers, gets consent, exchanges the code with PKCE, and then works as the owner allowed", async () => {
    const t = await register("full");
    const provider = new TestProvider(t.jwt, { scopes: ["agents:read", "agents:write"] });
    const client = await connect(provider);
    expect(client).not.toBeNull();

    // What the SDK sent the browser to: our consent page, with PKCE S256 and the MCP server as the resource.
    const url = provider.lastAuthorizeUrl!;
    expect(url.origin + url.pathname).toBe("http://localhost:3001/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(mcpUrl);
    expect(provider.saved?.access_token).toMatch(/^envoy_sk_/);
    expect(provider.saved?.refresh_token).toMatch(/^envoy_rt_/);

    const created = (await client!.callTool({ name: "create_agent", arguments: { name: "Made over OAuth" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(created.isError).toBeFalsy();
    expect(await prisma.agent.count({ where: { tenantId: t.tenantId, name: "Made over OAuth" } })).toBe(1);

    // Outside what was granted: refused by the API like any token.
    const refused = (await client!.callTool({ name: "list_conversations", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("conversations:read");
    await client!.close();
  }, 120000);

  it("when the hour is up, the client refreshes on its own and carries on", async () => {
    const t = await register("refresh");
    const provider = new TestProvider(t.jwt);
    const client = await connect(provider);
    const before = provider.saved!.access_token;
    await client!.close();

    await prisma.apiToken.updateMany({ where: { tenantId: t.tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } }); // the access token expires

    // A fresh connection hits 401 invalid_token at the MCP server, and the SDK refreshes without asking the person again.
    const again = new Client({ name: "sdk", version: "0" });
    await again.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }));
    expect(provider.saved!.access_token).not.toBe(before);
    expect((await again.listTools()).tools.length).toBeGreaterThan(20);
    expect(await prisma.apiToken.count({ where: { tenantId: t.tenantId } })).toBe(1);
    await again.close();
  }, 120000);

  it("if the owner says no, the client gets nothing", async () => {
    const t = await register("deny");
    const provider = new TestProvider(t.jwt, { deny: true });
    expect(await connect(provider)).toBeNull();
    expect(provider.saved).toBeUndefined();
    expect(await prisma.apiToken.count({ where: { tenantId: t.tenantId } })).toBe(0);
  }, 90000);

  it("once disconnected in the portal, it can't call tools or refresh its way back in", async () => {
    const t = await register("disconnect");
    const provider = new TestProvider(t.jwt);
    const client = await connect(provider);
    await client!.close();
    await prisma.apiToken.updateMany({ where: { tenantId: t.tenantId }, data: { revokedAt: new Date() } });
    const again = new Client({ name: "sdk", version: "0" });
    await expect(again.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }))).rejects.toBeTruthy();
    expect(await prisma.agent.count({ where: { tenantId: t.tenantId } })).toBe(0);
  }, 90000);
});
