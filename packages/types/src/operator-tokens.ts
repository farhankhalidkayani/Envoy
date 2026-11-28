import { z } from "zod";

/**
 * Tokens for the platform OPERATOR's AI assistant (the operator MCP server) — strictly separate from workspace
 * API tokens: a different prefix, a different table, its own two scopes, and a policy that only ever opens a short
 * allow-list of /admin routes. Anything that moves money, deletes a tenant or manages tokens stays with a person in
 * the admin console.
 */
export const OPERATOR_TOKEN_PREFIX = "envoy_op_";
export const OPERATOR_SCOPES = ["admin:read", "admin:write"] as const;
export const OperatorScope = z.enum(OPERATOR_SCOPES);
export type OperatorScope = z.infer<typeof OperatorScope>;

export const OPERATOR_SCOPE_LABELS: Record<OperatorScope, string> = {
  "admin:read": "See tenants, platform stats, the audit log and failed jobs",
  "admin:write": "Retry failed jobs, change a user's feature access, pause or resume a tenant (all reversible, all audited)",
};

/** Operator access is powerful: short-lived, and read-only unless write is chosen explicitly. */
export const OPERATOR_TOKEN_MAX_DAYS = 30;
export const CreateOperatorTokenInput = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(OperatorScope).min(1).max(OPERATOR_SCOPES.length).default(["admin:read"]),
  expiresInDays: z.number().int().min(1).max(OPERATOR_TOKEN_MAX_DAYS).default(7),
});
export type CreateOperatorTokenInput = z.infer<typeof CreateOperatorTokenInput>;

const ID = "[^/]+";
const ALLOWED: Array<{ method: string; pattern: RegExp; scope: OperatorScope }> = [
  { method: "GET", pattern: new RegExp(`^/admin/tenants$`), scope: "admin:read" },
  { method: "GET", pattern: new RegExp(`^/admin/tenants/${ID}$`), scope: "admin:read" }, // includes /stats
  { method: "GET", pattern: /^\/admin\/audit-log$/, scope: "admin:read" },
  { method: "GET", pattern: /^\/admin\/jobs\/failed$/, scope: "admin:read" },
  { method: "POST", pattern: new RegExp(`^/admin/jobs/${ID}/${ID}/retry$`), scope: "admin:write" },
  { method: "PATCH", pattern: new RegExp(`^/admin/tenants/${ID}/users/${ID}/access$`), scope: "admin:write" },
  { method: "PATCH", pattern: new RegExp(`^/admin/tenants/${ID}/(pause|resume)$`), scope: "admin:write" },
];

/** Recognised admin actions that are deliberately kept for a person, with the reason the AI is told. */
const NEEDS_A_PERSON: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/admin\/tenants\/[^/]+\/pricing$/, reason: "Changing a tenant's pricing is for a person, in the admin console." },
  { pattern: /^\/admin\/tenants\/[^/]+\/bill-overage$/, reason: "Charging a tenant is for a person, in the admin console." },
  { pattern: /^\/admin\/tenants\/[^/]+(\/hard)?$/, reason: "Deleting a tenant is for a person, in the admin console." },
  { pattern: /^\/admin\/operator-tokens/, reason: "Operator tokens can't manage operator tokens." },
];

export type OperatorAccess = { allowed: true; scope: OperatorScope } | { allowed: false; reason: string };

/** Pure: may an operator token holding `granted` make this request? */
export function decideOperatorAccess(method: string, rawPath: string, granted: readonly string[]): OperatorAccess {
  const path = rawPath.split("?")[0]!.replace(/\/+$/, "") || "/";
  const verb = method.toUpperCase();
  if (verb === "GET" && path === "/token-info" && granted.length > 0) return { allowed: true, scope: granted[0] as OperatorScope };

  const rule = ALLOWED.find((r) => r.method === verb && r.pattern.test(path));
  if (!rule) {
    const kept = NEEDS_A_PERSON.find((r) => r.pattern.test(path));
    if (kept) return { allowed: false, reason: kept.reason };
    return { allowed: false, reason: path.startsWith("/admin/") ? "This operator action isn't available to operator tokens." : "Operator tokens only reach the operator API." };
  }
  if (!granted.includes(rule.scope)) return { allowed: false, reason: `This operator token doesn't have the "${rule.scope}" scope.` };
  return { allowed: true, scope: rule.scope };
}
