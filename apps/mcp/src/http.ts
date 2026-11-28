#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { API_TOKEN_SCOPES } from "@envoy/types";
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

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  void res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...headers }).end(JSON.stringify(body));

export interface HttpServerOptions {
  /** This server's public /mcp URL — the "resource" OAuth tokens are issued for. Default: derived from the request. */
  publicUrl?: string;
  /** The Envoy API's public URL, where clients sign in. Default: apiBaseUrl. */
  authServerUrl?: string;
}

/**
 * Remote MCP over Streamable HTTP, stateless: each request carries the caller's own Envoy token
 * (Authorization: Bearer envoy_sk_…) — pasted from the portal, or obtained by signing in through OAuth — and is
 * forwarded to the Envoy API as that caller. This server stores no tokens and holds no state; scopes, limits and
 * audit are all enforced by the API.
 *
 * For OAuth (MCP authorization spec): without a valid token it answers 401 with a `WWW-Authenticate` header pointing
 * at its protected-resource metadata, which names the Envoy API as the place to sign in.
 */
export function createHttpServer(apiBaseUrl: string, opts: HttpServerOptions = {}) {
  const authServer = (opts.authServerUrl ?? apiBaseUrl).replace(/\/$/, "");
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const origin = `http://${req.headers.host ?? "localhost"}`;
    const resource = (opts.publicUrl ?? `${origin}/mcp`).replace(/\/$/, "");
    const metadataUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource`;
    const challenge = (extra = "") => ({ "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"${extra}` });

    if (path === "/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    if (req.method === "OPTIONS") return void res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST" }).end();

    // RFC 9728, at the root and at the path-suffixed location some clients try first.
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      return json(res, 200, { resource, authorization_servers: [authServer], bearer_methods_supported: ["header"], resource_name: "Envoy", scopes_supported: API_TOKEN_SCOPES });
    }
    // Older clients (MCP spec 2025-03-26) look for the sign-in metadata on this host: hand them the API's.
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      try {
        const upstream = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
        return json(res, upstream.status, await upstream.json());
      } catch {
        return json(res, 502, { error: "temporarily_unavailable" });
      }
    }

    if (path !== "/mcp") return void res.writeHead(404).end();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end(); // stateless: no SSE stream, no sessions to delete

    const token = /^Bearer\s+(envoy_sk_\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) {
      res.setHeader("WWW-Authenticate", challenge()["WWW-Authenticate"]);
      return rpcError(res, 401, "Sign in to connect to Envoy, or send an Envoy API token as 'Authorization: Bearer envoy_sk_…'.");
    }

    // Is the token still good? An expired one must get a real 401, so the client refreshes or signs in again.
    try {
      const check = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/token-info`, { headers: { Authorization: `Bearer ${token}` } });
      if (check.status === 401) {
        res.setHeader("WWW-Authenticate", challenge(', error="invalid_token"')["WWW-Authenticate"]);
        return rpcError(res, 401, "This Envoy token is invalid, expired or revoked.");
      }
      if (check.status === 429) return rpcError(res, 429, "Too many requests for this token. Slow down.");
    } catch {
      return rpcError(res, 502, "Couldn't reach Envoy. Try again in a moment.");
    }

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
  createHttpServer(process.env.ENVOY_API_URL ?? "http://localhost:4000", { publicUrl: process.env.MCP_PUBLIC_URL, authServerUrl: process.env.ENVOY_PUBLIC_API_URL }).listen(port, () => console.error(`Envoy MCP (HTTP) listening on :${port}/mcp`));
}
