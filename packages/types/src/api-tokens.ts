import { z } from "zod";
import { OPT_IN_TOOL_NAMES } from "./agent-spec.js";

/**
 * API tokens let a program — and through MCP, an AI agent — act on a
 * workspace. They are deliberately weaker than a signed-in person: a fixed
 * menu of scopes, no access to accounts, billing changes, model keys or the
 * operator console, and no way to take the few actions that need a human.
 */

export const API_TOKEN_SCOPES = [
  "agents:read",
  "agents:write",
  "conversations:read",
  "forms:read",
  "forms:write",
  "models:read",
  "billing:read",
  "integrations:read",
  "approvals:read",
  "approvals:write",
] as const;
export const ApiTokenScope = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

export const API_TOKEN_SCOPE_LABELS: Record<ApiTokenScope, string> = {
  "agents:read": "See agents, scenarios, versions and improvement findings",
  "agents:write": "Edit agents, run the playground and scenarios, draft improvements",
  "conversations:read": "Read conversations, transcripts, leads and run traces",
  "forms:read": "See lead forms and their submissions",
  "forms:write": "Create and edit lead forms",
  "models:read": "See which AI models serve the workspace, and usage",
  "billing:read": "See subscription and usage",
  "integrations:read": "See which CRM and integrations are connected",
  "approvals:read": "See the status of requests for a person's approval",
  "approvals:write": "Ask a person to approve something (publish an agent, change hard rules…) — it still needs their yes",
};

/** Route area → the scope family a request needs. Anything not listed is closed to tokens. */
const AREA_OF_FIRST_SEGMENT: Record<string, "agents" | "conversations" | "forms" | "models" | "billing" | "integrations" | "approvals"> = {
  agents: "agents",
  conversations: "conversations",
  leads: "conversations",
  forms: "forms",
  models: "models",
  billing: "billing",
  crm: "integrations",
  integrations: "integrations",
  approvals: "approvals",
};

/**
 * Actions a person must take, even where the area is otherwise open:
 *  - deciding an approval request (a token may ask; only a person may answer),
 *  - approving or rejecting an AI-drafted change to a live agent,
 *  - restoring an old version (a snapshot can carry different hard rules).
 */
const NEEDS_A_PERSON: Array<{ method: string; pattern: RegExp; reason: string }> = [
  { method: "POST", pattern: /^\/approvals\/[^/]+\/(approve|reject)$/, reason: "Only a person can decide an approval request — in the portal." },
  { method: "POST", pattern: /^\/agents\/[^/]+\/improvement\/proposals\/[^/]+\/(approve|reject)$/, reason: "Approving or rejecting an improvement is a decision for a person — do it in the portal." },
  { method: "POST", pattern: /^\/agents\/[^/]+\/versions\/[^/]+\/restore$/, reason: "Restoring a version can change hard rules — do it in the portal." },
];

export type TokenAccess = { allowed: true; scope: ApiTokenScope } | { allowed: false; reason: string };

/** Pure: may a token holding `granted` scopes make this request? */
export function decideTokenAccess(method: string, rawPath: string, granted: readonly string[]): TokenAccess {
  const path = rawPath.split("?")[0]!.replace(/\/+$/, "") || "/";
  const verb = method.toUpperCase();

  // Any valid token may ask about itself (the MCP server checks this before each request, to answer 401 on an expired one).
  if (verb === "GET" && path === "/token-info" && granted.length > 0) return { allowed: true, scope: granted[0] as ApiTokenScope };

  const area = AREA_OF_FIRST_SEGMENT[path.split("/")[1] ?? ""];
  if (!area) return { allowed: false, reason: "This endpoint isn't available to API tokens." };

  const blocked = NEEDS_A_PERSON.find((r) => r.method === verb && r.pattern.test(path));
  if (blocked) return { allowed: false, reason: blocked.reason };

  const scope = `${area}:${verb === "GET" || verb === "HEAD" ? "read" : "write"}`;
  if (!(API_TOKEN_SCOPES as readonly string[]).includes(scope)) {
    return { allowed: false, reason: `API tokens can't make changes to ${area}.` };
  }
  if (!granted.includes(scope)) return { allowed: false, reason: `This token doesn't have the "${scope}" scope.` };
  return { allowed: true, scope: scope as ApiTokenScope };
}

/**
 * What a token may NOT put in an agent edit, even with agents:write: hard
 * rules (rules only ever change with a person present), publishing it live,
 * and switching on the CRM/calendar tools (that hands the agent access to the
 * tenant's own systems). Returns the reason, or null if the edit is fine.
 */
export function forbiddenAgentEditForToken(
  body: { hardRules?: unknown; status?: unknown; spec?: { tools?: Array<{ name: string; enabled?: boolean }> } },
  /** Opt-in tools already enabled on the agent being edited. Re-sending them unchanged (a normal read-modify-write) is fine; newly enabling one is not. */
  alreadyEnabled: ReadonlySet<string> = new Set(),
): string | null {
  if (body.hardRules !== undefined) return "Hard rules can only be changed by a person, in the portal.";
  if (body.status === "live") return "Publishing an agent to visitors needs a person — publish it from the portal.";
  const enablesIntegration = body.spec?.tools?.some(
    (t) => (OPT_IN_TOOL_NAMES as readonly string[]).includes(t.name) && t.enabled !== false && !alreadyEnabled.has(t.name),
  );
  if (enablesIntegration) return "Giving an agent access to your CRM or calendar needs a person — enable those tools in the portal.";
  return null;
}

export const CreateApiTokenInput = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(ApiTokenScope).min(1).max(API_TOKEN_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenInput>;

export const API_TOKEN_PREFIX = "envoy_sk_";
