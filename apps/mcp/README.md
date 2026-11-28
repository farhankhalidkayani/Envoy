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

(`pnpm --filter @envoy/mcp build` first.)

### Remote: sign in instead of pasting a token

Run `pnpm --filter @envoy/mcp start:http` and add `https://<your-mcp-host>/mcp` to the client (Claude, Cursor, MCP
Inspector, …) as a remote server. The client finds its own way to sign in (MCP authorization spec, OAuth 2.1):

1. Its first request gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
2. `/.well-known/oauth-protected-resource` names the Envoy API as the place to sign in, and the API's
   `/.well-known/oauth-authorization-server` lists its endpoints. Older clients that look for that second document on the
   MCP host get it there too.
3. The client registers itself (`POST /oauth/register`, public client, no secret) and opens the portal's consent page
   (`/oauth/authorize`). The workspace owner, signed in, sees the app, where it returns to and the permissions it asked
   for, ticks what to grant, and allows or denies.
4. The client exchanges the one-time code (10 minutes, single use, bound to the client, return address, PKCE `S256`
   verifier and this MCP server as the resource) for an hourly access token and a 30-day refresh token. Each refresh
   rotates both. An old refresh token coming back ends the connection, as does a code used twice.

What it gets is an ordinary Envoy API token, so scopes, rate limits, the audit trail and everything a token can never do
apply unchanged. It appears under **API & MCP** as a *connected app*, which you can disconnect at any time. Before each
request the server checks the token, so an expired one gets a proper `401` and the client refreshes by itself.

Settings: `PORT`, `ENVOY_API_URL` (how this server reaches the API), `MCP_PUBLIC_URL` (this server's public `/mcp`
URL), `ENVOY_PUBLIC_API_URL` (the API's public URL, if different). On the API: `PUBLIC_API_URL`, `PORTAL_URL` and
`MCP_PUBLIC_URL`.

Scripts and clients without OAuth can still send `Authorization: Bearer envoy_sk_…` with a token made in the portal. The
HTTP server is stateless and forwards each caller's own token; it stores nothing.

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
after 24 hours and is void if the agent changes first. The owner is emailed when requests arrive (at most once per 15
minutes); the email links to the inbox and contains none of the assistant's own words.

Text from conversations, leads and form submissions is returned behind an explicit "untrusted data" notice so an
assistant doesn't act on instructions a visitor typed.

## Operator server (for the people who run the platform)

A separate server with its own credential, for a platform admin's AI assistant. It runs **locally over stdio only**;
the HTTP server refuses operator tokens.

1. In the admin console open **AI access** and create an operator token (`envoy_op_…`). It is read-only unless you tick
   write access, lasts 1–30 days (7 by default), and at most five can be active.
2. Add it to your MCP app:

```json
{ "mcpServers": { "envoy-operator": { "command": "node", "args": ["/path/to/Envoy/apps/mcp/dist/stdio-operator.js"],
  "env": { "ENVOY_API_URL": "https://your-api", "ENVOY_OPERATOR_TOKEN": "envoy_op_…" } } } }
```

Tools: `platform_stats`, `list_tenants`, `get_tenant`, `get_audit_log`, `list_failed_jobs` (`admin:read`); `retry_job`,
`set_user_feature` (one flag for one user, leaving the rest), `pause_tenant`, `resume_tenant` (`admin:write`). Never
available to it, whatever the scopes: changing pricing, charging a tenant, deleting a tenant, or managing tokens. The API
enforces this with an allow-list of `/admin` routes, so an operator token can't reach a workspace's API and a workspace
token can't reach the operator API. Tenant-written data (names, emails, audit details, job data) is marked untrusted.
Every change is audited under the token's name, and a token stops working the moment its admin stops being a platform
admin.

## Not yet

Push notification of new approval requests (the owner is emailed, at most once per 15 minutes, and the portal shows a count); clean-up of apps that registered but never
connected; and an operator-side server.
