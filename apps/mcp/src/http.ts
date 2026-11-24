#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EnvoyApi } from "./api.js";
import { createEnvoyServer } from "./server.js";

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) return reject(new Error("too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const rpcError = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
};

/**
 * Remote MCP over Streamable HTTP, stateless: each request is authenticated with the caller's own Envoy API token
 * (Authorization: Bearer envoy_sk_…) and forwarded to the Envoy API as that caller. This server stores no tokens
 * and holds no state; scopes, limits and audit are all enforced by the API.
 */
export function createHttpServer(apiBaseUrl: string) {
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    if (path !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end(); // stateless: no SSE stream, no sessions to delete

    const token = /^Bearer\s+(envoy_sk_\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return rpcError(res, 401, "Send your Envoy API token as 'Authorization: Bearer envoy_sk_…'.");

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return rpcError(res, 400, "Invalid or oversized request body.");
    }

    const server = createEnvoyServer(new EnvoyApi({ baseUrl: apiBaseUrl, token }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) rpcError(res, 500, "Internal error.");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4100);
  createHttpServer(process.env.ENVOY_API_URL ?? "http://localhost:4000").listen(port, () => console.error(`Envoy MCP (HTTP) listening on :${port}/mcp`));
}
