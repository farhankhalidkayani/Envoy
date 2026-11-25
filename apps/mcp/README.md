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

## What it can never do — but can ask for

Publish an agent to visitors, change hard rules, approve or reject an AI-drafted improvement, restore a version, enable
CRM/calendar tools for an agent, or touch billing, AI model keys, accounts, other tokens or the operator console. These
are refused by the **API** (not merely left out of the tool list) and always need a person.

For the first five, the assistant can **ask**: the `request_*` tools (token scopes `approvals:write` / `approvals:read`)
send a request that the workspace owner reviews in the portal under **Approvals**. The reviewer sees a summary built from
the agent's real state (for hard rules: exactly what is added, changed and removed), the assistant's reason clearly marked as
its own words, and warnings. Only the owner, signed in, can approve; the action then runs once, as them. A request expires
after 24 hours and is void if the agent changes first.

Text from conversations, leads and form submissions is returned behind an explicit "untrusted data" notice so an
assistant doesn't act on instructions a visitor typed.

## Not yet

OAuth 2.1 sign-in for remote clients (tokens are the only credential today), email/push notification of new approval
requests (the portal shows a count), and an operator-side server.
