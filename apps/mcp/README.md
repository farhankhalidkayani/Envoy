# Envoy MCP server

Lets an AI assistant (Claude, ChatGPT, Cursor, or your own agent) operate an Envoy workspace over the
[Model Context Protocol](https://modelcontextprotocol.io). It has no logic of its own: every tool is one call to the
Envoy API made with a **scoped API token**, so tenant isolation, scopes, feature flags, the workspace lock, rate
limits and the audit log are all enforced by the API.

## Connect

1. In the portal open **API & MCP** and create a token (pick the scopes the assistant needs). The secret is shown once.
2. Add the server to your MCP app. For a local app (e.g. Claude Desktop) over stdio:

```json
{
  "mcpServers": {
    "envoy": {
      "command": "node",
      "args": ["/path/to/Envoy/apps/mcp/dist/stdio.js"],
      "env": { "ENVOY_API_URL": "http://localhost:4000", "ENVOY_API_TOKEN": "envoy_sk_…" }
    }
  }
}
```

(`pnpm --filter @envoy/mcp build` first.) For a remote client, run `pnpm --filter @envoy/mcp start:http`
(`PORT`, `ENVOY_API_URL`) and point the client at `POST /mcp` with `Authorization: Bearer envoy_sk_…`. The HTTP server is
stateless and forwards each caller's own token; it stores nothing.

## What it can do

Build and edit agents (as drafts), try them in a sandbox (`simulate_conversation`), save and run scenarios, compare
models, read conversations/leads/traces, see model usage and billing status, diagnose an agent from real conversations
and draft and test a fix. Resources: `envoy://reference/vocabulary`, `envoy://agents/{id}`. Prompts:
`build_lead_qualifier`, `diagnose_agent`, `weekly_leads_digest`.

## What it can never do

Publish an agent to visitors, change hard rules, approve or reject an AI-drafted improvement, restore a version, enable
CRM/calendar tools for an agent, or touch billing, AI model keys, accounts, other tokens or the operator console. These
are refused by the **API** (not merely left out of the tool list) and always need a person in the portal.

Text from conversations, leads and form submissions is returned behind an explicit "untrusted data" notice so an
assistant doesn't act on instructions a visitor typed.

## Not yet

OAuth 2.1 sign-in for remote clients (tokens are the only credential today), an in-product approval link for the
actions above, and an operator-side server.
