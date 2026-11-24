import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "./http.js";

describe("Streamable HTTP transport", () => {
  let api: Server;
  let mcp: Server;
  let mcpUrl: string;
  const seen: Array<{ url: string; auth?: string }> = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ id: "a1", name: "Bot", status: "draft", version: 1, spec: { runtime: { mode: "classic" } }, updatedAt: "t" }]));
    }).listen(0);
    await once(api, "listening");
    mcp = createHttpServer(`http://localhost:${(api.address() as AddressInfo).port}`).listen(0);
    await once(mcp, "listening");
    mcpUrl = `http://localhost:${(mcp.address() as AddressInfo).port}`;
  });
  afterAll(() => { api.close(); mcp.close(); });

  const post = (headers: Record<string, string>, body: string) => fetch(`${mcpUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body });

  it("serves a real MCP client and forwards the caller's own token to the API", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: "Bearer envoy_sk_callerA" } } }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
    const res = (await client.callTool({ name: "list_agents", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text)[0]).toMatchObject({ id: "a1", mode: "classic" });
    expect(seen.at(-1)).toEqual({ url: "/agents", auth: "Bearer envoy_sk_callerA" });
    await client.close();
  });

  it("keeps callers separate: a second caller's token is the one forwarded for its calls", async () => {
    const connectAs = async (token: string) => {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return c;
    };
    const [a, b] = await Promise.all([connectAs("envoy_sk_AAAA"), connectAs("envoy_sk_BBBB")]);
    await a.callTool({ name: "list_agents", arguments: {} });
    expect(seen.at(-1)!.auth).toBe("Bearer envoy_sk_AAAA");
    await b.callTool({ name: "list_agents", arguments: {} });
    expect(seen.at(-1)!.auth).toBe("Bearer envoy_sk_BBBB");
    await Promise.all([a.close(), b.close()]);
  });

  it("refuses a request with no Envoy token, or a different kind of credential", async () => {
    for (const headers of [{}, { Authorization: "Bearer eyJhbGciOi.JWT.like" }, { Authorization: "Basic abc" }, { Authorization: "Bearer " }]) {
      const res = await post(headers, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("envoy_sk_");
    }
  });

  it("only accepts POST on /mcp (it is stateless: no streams, no sessions)", async () => {
    expect((await fetch(`${mcpUrl}/mcp`)).status).toBe(405);
    expect((await fetch(`${mcpUrl}/mcp`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${mcpUrl}/elsewhere`)).status).toBe(404);
    expect(await (await fetch(`${mcpUrl}/health`)).json()).toEqual({ ok: true });
  });

  it("rejects malformed and oversized bodies without crashing", async () => {
    expect((await post({ Authorization: "Bearer envoy_sk_x" }, "{not json")).status).toBe(400);
    expect((await post({ Authorization: "Bearer envoy_sk_x" }, JSON.stringify({ pad: "x".repeat(1_100_000) }))).status).toBe(400);
    expect((await fetch(`${mcpUrl}/health`)).status).toBe(200); // still up
  });
});
