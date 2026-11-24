#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnvoyApi } from "./api.js";
import { createEnvoyServer } from "./server.js";

// stdout carries the MCP protocol itself, so anything for a human goes to stderr.
const token = process.env.ENVOY_API_TOKEN;
if (!token?.startsWith("envoy_sk_")) {
  console.error("ENVOY_API_TOKEN must be set to an Envoy API token (envoy_sk_…). Create one in the portal under Settings → API & MCP.");
  process.exit(1);
}
const baseUrl = process.env.ENVOY_API_URL ?? "http://localhost:4000";

await createEnvoyServer(new EnvoyApi({ baseUrl, token })).connect(new StdioServerTransport());
console.error(`Envoy MCP server ready (${baseUrl})`);
