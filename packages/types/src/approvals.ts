import { z } from "zod";
import { HardRuleDef } from "./hard-rules.js";
import { OPT_IN_TOOL_NAMES } from "./agent-spec.js";

/**
 * Approval requests: how an AI assistant (or any API token) asks for the few things that always need a person.
 * The request stores the exact action; a person reviews a summary the SERVER builds from the real data, and only
 * their approval — never the token's — carries it out, as them, and only if nothing has changed since it was asked.
 */

export const APPROVAL_KINDS = ["publish_agent", "restore_version", "approve_proposal", "set_hard_rules", "enable_tools"] as const;
export const ApprovalKind = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  publish_agent: "Publish an agent to visitors",
  restore_version: "Restore an earlier version of an agent",
  approve_proposal: "Apply a proposed improvement",
  set_hard_rules: "Change an agent's hard rules",
  enable_tools: "Give an agent access to your CRM or calendar",
};

/** What each kind is allowed to ask for. Anything else is not a thing a request can express. */
export const ApprovalParams = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish_agent") }),
  z.object({ kind: z.literal("restore_version"), version: z.number().int().min(1) }),
  z.object({ kind: z.literal("approve_proposal"), proposalId: z.string().min(1), acknowledgeUntested: z.boolean().optional() }),
  z.object({ kind: z.literal("set_hard_rules"), hardRules: z.array(HardRuleDef).max(50) }),
  z.object({ kind: z.literal("enable_tools"), tools: z.array(z.enum(OPT_IN_TOOL_NAMES as unknown as [string, ...string[]])).min(1).max(OPT_IN_TOOL_NAMES.length) }),
]);
export type ApprovalParams = z.infer<typeof ApprovalParams>;

export const CreateApprovalInput = z.object({
  agentId: z.string().min(1),
  params: ApprovalParams,
  /** The requester's own words, shown to the reviewer clearly labelled as coming from the requester. Never trusted. */
  reason: z.string().trim().max(500).optional(),
});
export type CreateApprovalInput = z.infer<typeof CreateApprovalInput>;

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "stale", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** How long a request stays open. A decision made days later is about a world that has moved on. */
export const APPROVAL_TTL_HOURS = 24;
/** Open requests one token may have at once, so a confused or manipulated assistant can't bury the owner. */
export const MAX_PENDING_PER_TOKEN = 5;

/** The set of opt-in tools are CRM/calendar tools; naming them is what the summary shows the reviewer. */
export const TOOL_ACCESS_NOTES: Record<string, string> = {
  lookup_crm_contact: "Look up whether a visitor is already in your CRM (first name only)",
  check_calendar_availability: "See which times are busy on your calendar (times only)",
  book_meeting: "Book meetings on your calendar",
};

/** A stable fingerprint of what a request asks for, so the executed action is provably the one that was reviewed. */
export function canonicalParams(params: ApprovalParams): string {
  return JSON.stringify(params, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}
