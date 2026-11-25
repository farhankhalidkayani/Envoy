import { z } from "zod";
import { ConditionOp, evaluateCondition } from "./form-schema.js";
import { OutcomeType } from "./enums.js";

/**
 * Follow-up workflows: when a lead arrives (a finished conversation or a form
 * submission) and meets some conditions, send it a sequence of emails and
 * SMS messages over time. Everything that decides WHETHER and WHEN a message
 * may go out — conditions, consent, quiet hours, opt-outs — lives here as pure
 * functions, so the server, the preview and the tests all agree.
 */

export const WORKFLOW_TRIGGER_TYPES = ["conversation_completed", "form_submitted"] as const;

export const WorkflowTrigger = z.object({
  type: z.enum(WORKFLOW_TRIGGER_TYPES),
  /** Only leads from this agent (conversation_completed) or form (form_submitted). Omit for any. */
  agentId: z.string().min(1).optional(),
  formId: z.string().min(1).optional(),
});
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

/** `$outcome` is the conversation's outcome (demo_booking…); every other field is a captured/submitted value. */
export const OUTCOME_FIELD = "$outcome";

export const WorkflowCondition = z.object({
  field: z.string().min(1).max(64),
  op: ConditionOp,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type WorkflowCondition = z.infer<typeof WorkflowCondition>;

export const WorkflowConditions = z.object({
  match: z.enum(["all", "any"]).default("all"),
  /** Empty means every lead qualifies. */
  conditions: z.array(WorkflowCondition).max(20).default([]),
});
export type WorkflowConditions = z.infer<typeof WorkflowConditions>;

export const WAIT_UNITS = ["minutes", "hours", "days"] as const;

/**
 * Any step may carry `when`: it only runs if the lead meets these conditions at the moment the step is reached (using
 * the lead's current data), and is skipped otherwise. Two steps with opposite conditions make an if/else; an `exit`
 * step with a condition ends the sequence early. Steps stay in one straight line, so run state and logs stay simple.
 */
const when = { when: WorkflowConditions.optional() };

const WaitStep = z.object({ type: z.literal("wait"), amount: z.number().int().min(1).max(60 * 24 * 30), unit: z.enum(WAIT_UNITS), ...when });
const ExitStep = z.object({ type: z.literal("exit"), ...when });
const EmailStep = z.object({
  type: z.literal("send_email"),
  /** "lead" emails the lead (opt-out and unsubscribe rules apply); an address notifies your own team. */
  to: z.union([z.literal("lead"), z.string().email()]).default("lead"),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  ...when,
});
const SmsStep = z.object({ type: z.literal("send_sms"), body: z.string().trim().min(1).max(480), ...when });

export const WorkflowStep = z.discriminatedUnion("type", [WaitStep, EmailStep, SmsStep, ExitStep]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

/** Longest a single workflow may run, so a typo can't leave a lead in limbo for a year. */
export const MAX_WORKFLOW_DAYS = 60;
export const MAX_WORKFLOW_STEPS = 12;

export const QuietHours = z.object({
  /** Messages (SMS) that would land in this window wait until it ends. */
  enabled: z.boolean().default(true),
  startHour: z.number().int().min(0).max(23).default(21),
  endHour: z.number().int().min(0).max(23).default(8),
});
export type QuietHours = z.infer<typeof QuietHours>;

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const WorkflowSettings = z.object({
  /** Which captured/submitted field holds the lead's email and phone. */
  emailField: z.string().min(1).max(64).default("email"),
  phoneField: z.string().min(1).max(64).default("phone"),
  /** If set, SMS only goes to leads whose value for this field is a clear yes (a consent checkbox). */
  smsConsentField: z.string().min(1).max(64).optional(),
  /** Whose clock the quiet hours follow — the lead's likely time zone, e.g. "Europe/London". */
  timezone: z.string().refine(isTimeZone, "Unknown time zone").default("UTC"),
  quietHours: QuietHours.default({}),
  /** Stop the sequence when the lead replies by SMS. */
  exitOnReply: z.boolean().default(true),
  /** Named in the footer of emails to leads. Defaults to the workspace name. */
  businessName: z.string().max(100).optional(),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettings>;

const totalWaitMs = (steps: readonly WorkflowStep[]) => steps.reduce((n, s) => n + (s.type === "wait" ? delayMs(s) : 0), 0);

export const WorkflowDef = z
  .object({
    name: z.string().trim().min(1).max(100),
    trigger: WorkflowTrigger,
    conditions: WorkflowConditions.default({}),
    steps: z.array(WorkflowStep).min(1).max(MAX_WORKFLOW_STEPS),
    settings: WorkflowSettings.default({}),
  })
  .superRefine((w, ctx) => {
    if (w.steps.every((s) => s.type === "wait" || s.type === "exit")) ctx.addIssue({ code: "custom", message: "A workflow needs at least one message to send", path: ["steps"] });
    w.steps.forEach((step, i) => {
      // "End here" with no condition would just cut the sequence short for everyone; that's a mistake, not a design.
      if (step.type === "exit" && (!step.when || step.when.conditions.length === 0)) ctx.addIssue({ code: "custom", message: "An “end here” step needs a condition (otherwise nothing after it would ever run)", path: ["steps", i, "when"] });
    });
    if (totalWaitMs(w.steps) > MAX_WORKFLOW_DAYS * 86_400_000) ctx.addIssue({ code: "custom", message: `Waits add up to more than ${MAX_WORKFLOW_DAYS} days`, path: ["steps"] });
    if (w.trigger.type === "conversation_completed" && w.trigger.formId) ctx.addIssue({ code: "custom", message: "A conversation trigger can't filter by form", path: ["trigger", "formId"] });
    if (w.trigger.type === "form_submitted" && w.trigger.agentId) ctx.addIssue({ code: "custom", message: "A form trigger can't filter by agent", path: ["trigger", "agentId"] });
  });
export type WorkflowDef = z.infer<typeof WorkflowDef>;

export const WorkflowStatus = z.enum(["draft", "live", "paused"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const WORKFLOW_RUN_STATUSES = ["running", "completed", "stopped", "failed"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// ── pure rules ────────────────────────────────────────────────

export type WaitStep = Extract<WorkflowStep, { type: "wait" }>;

export function delayMs(step: WaitStep): number {
  const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[step.unit];
  return step.amount * unit;
}

/** Whether a lead meets a workflow's conditions. `outcome` feeds the special `$outcome` field. */
export function leadMatches(conditions: WorkflowConditions, data: Record<string, unknown>, outcome?: string | null): boolean {
  if (conditions.conditions.length === 0) return true;
  const withOutcome = { ...data, [OUTCOME_FIELD]: outcome ?? "" };
  const results = conditions.conditions.map((c) => evaluateCondition({ fieldKey: c.field, op: c.op, value: c.value }, withOutcome));
  return conditions.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

const OP_TEXT: Record<string, string> = { equals: "is", not_equals: "is not", contains: "contains", gt: "is more than", lt: "is less than", is_empty: "is empty", is_not_empty: "is not empty" };

/** A condition set in plain words, for logs and previews: `budget is more than 5000 and plan is pro`. */
export function describeConditions(c: WorkflowConditions): string {
  const parts = c.conditions.map((x) => `${x.field === OUTCOME_FIELD ? "outcome" : x.field} ${OP_TEXT[x.op] ?? x.op}${x.value === undefined || x.op.startsWith("is_") ? "" : ` ${String(x.value)}`}`);
  return parts.join(c.match === "any" ? " or " : " and ");
}

/** Whether a step should run for this lead right now: no condition means always. */
export function stepApplies(step: WorkflowStep, data: Record<string, unknown>, outcome?: string | null): boolean {
  return !step.when || leadMatches(step.when, data, outcome);
}

export const OUTCOME_VALUES = OutcomeType.options;

/** Lower-cased, trimmed, or null if it isn't plausibly an email address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null;
}

/**
 * E.164-style number, or null. Only numbers written internationally ("+44…" or "0044…") are accepted: a bare local
 * number can't be routed without guessing the country, and texting the wrong person is worse than not texting.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[\s().-]/g, "");
  const international = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
}

/** A clear "yes" from a consent field (checkbox or text). Anything else, including blank, is no consent. */
export function isConsentGiven(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["yes", "y", "true", "1", "on", "checked", "agree", "agreed", "i agree"].includes(value.trim().toLowerCase());
}

const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START_WORDS = ["START", "UNSTOP"];
const keyword = (text: string) => text.trim().toUpperCase().replace(/[.!]+$/, "");
/** The standard carrier keywords for opting out of / back in to SMS. */
export const isStopKeyword = (text: string) => STOP_WORDS.includes(keyword(text));
export const isStartKeyword = (text: string) => START_WORDS.includes(keyword(text));

/** Every SMS to a lead says how to stop. */
export function withSmsOptOutNotice(body: string): string {
  return /\bSTOP\b/i.test(body) ? body : `${body}\nReply STOP to opt out.`;
}

/** The local hour (0-23) in a time zone at an instant. */
function localHour(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(at).find((p) => p.type === "hour")!.value;
  return Number(h) % 24;
}

/** Quiet hours may wrap midnight (21→8). start === end means there are none. */
export function isInQuietHours(at: Date, settings: Pick<WorkflowSettings, "timezone" | "quietHours">): boolean {
  const { enabled, startHour, endHour } = settings.quietHours;
  if (!enabled || startHour === endHour) return false;
  const hour = localHour(at, settings.timezone);
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/** How long to hold a message so it lands outside quiet hours: 0 if it can go now, else until the window ends (to the minute). */
export function quietHoursDelayMs(at: Date, settings: Pick<WorkflowSettings, "timezone" | "quietHours">): number {
  if (!isInQuietHours(at, settings)) return 0;
  // Step forward a minute at a time until the window ends. Bounded by a day; robust to DST and half-hour zones.
  for (let minutes = 1; minutes <= 24 * 60; minutes++) {
    if (!isInQuietHours(new Date(at.getTime() + minutes * 60_000), settings)) return minutes * 60_000 - (at.getTime() % 60_000);
  }
  return 0;
}

export const CreateWorkflowInput = WorkflowDef;
export type CreateWorkflowInput = WorkflowDef;
