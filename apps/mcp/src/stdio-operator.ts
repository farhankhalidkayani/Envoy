#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OPERATOR_TOKEN_PREFIX } from "@envoy/types";
import { EnvoyApi } from "./api.js";
import { createOperatorServer } from "./operator.js";

// The operator server runs locally over stdio only: operator access is too powerful to expose as a remote endpoint.
const token = process.env.ENVOY_OPERATOR_TOKEN;
if (!token?.startsWith(OPERATOR_TOKEN_PREFIX)) {
  console.error("ENVOY_OPERATOR_TOKEN must be set to an operator token (envoy_op_…). Create one in the admin console under AI access.");
  process.exit(1);
}
const baseUrl = process.env.ENVOY_API_URL ?? "http://localhost:4000";

await createOperatorServer(new EnvoyApi({ baseUrl, token })).connect(new StdioServerTransport());
console.error(`Envoy operator MCP server ready (${baseUrl})`);
