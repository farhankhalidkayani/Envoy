import { z } from "zod";
import {
  OutcomeType,
  validateFieldValue,
  type RequiredFieldDef,
} from "@envoy/types";
import type { AgentTool, ToolConfig } from "./tool.js";

/** Visitors speak in text; models pass values as text too (providers disagree on union types), so coerce to the field's real type before validating. */
function coerce(field: RequiredFieldDef, raw: string | number | boolean): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (field.type === "number") {
    const n = Number(text);
    return text !== "" && Number.isFinite(n) ? n : raw;
  }
  if (field.type === "boolean") {
    if (/^(true|yes|y)$/i.test(text)) return true;
    if (/^(false|no|n)$/i.test(text)) return false;
  }
  return raw;
}

export function missingRequiredKeys(config: ToolConfig, captured: Record<string, unknown>): string[] {
  return config.requiredFields
    .filter((f) => f.required && !(f.key in captured))
    .map((f) => f.key);
}

const captureField: AgentTool = {
  name: "capture_field",
  description:
    "Record a piece of information the visitor has given you. Call this as soon as the visitor provides a value for one of the required fields. The value is validated; if it is rejected, ask the visitor again.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "The field key, exactly as listed in the required fields." },
      value: {
        type: "string",
        description: "The value as the visitor gave it. Write numbers as digits and booleans as true or false.",
      },
    },
    required: ["key", "value"],
  },
  input: z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }),
  isAvailable: (config) => config.requiredFields.length > 0,
  async execute({ key, value }, { config, state }) {
    const field = config.requiredFields.find((f) => f.key === key);
    if (!field) {
      return { ok: false, error: `Unknown field "${key}". Valid keys: ${config.requiredFields.map((f) => f.key).join(", ")}.` };
    }
    const outcome = validateFieldValue(field, coerce(field, value));
    if (!outcome.valid) {
      return { ok: false, error: `Value rejected for "${key}": ${outcome.error}. Ask the visitor to provide it again.` };
    }
    state.capturedData[key] = outcome.value;
    return { ok: true, data: { captured: key, stillMissing: missingRequiredKeys(config, state.capturedData) } };
  },
};

const updateGoal: AgentTool = {
  name: "update_goal",
  description:
    "Report progress on one of your goals. Mark a goal achieved only when its success criteria are actually met, or failed if it can no longer be met.",
  parameters: {
    type: "object",
    properties: {
      goalId: { type: "string", description: "The goal id, exactly as listed under your goals." },
      status: { type: "string", enum: ["in_progress", "achieved", "failed"] },
      note: { type: "string", description: "One short sentence on why." },
    },
    required: ["goalId", "status"],
  },
  input: z.object({
    goalId: z.string().min(1),
    status: z.enum(["in_progress", "achieved", "failed"]),
    note: z.string().max(500).optional(),
  }),
  isAvailable: (config) => config.goals.length > 0,
  async execute({ goalId, status, note }, { config, state }) {
    if (!config.goals.some((g) => g.id === goalId)) {
      return { ok: false, error: `Unknown goal "${goalId}". Valid ids: ${config.goals.map((g) => g.id).join(", ")}.` };
    }
    state.goalProgress[goalId] = { status, note, updatedAt: new Date().toISOString() };
    return { ok: true, data: { goalId, status } };
  },
};

const endConversation: AgentTool = {
  name: "end_conversation",
  description:
    "Finish the conversation once every required field is captured and your goals are resolved. After calling this, write a short closing message to the visitor.",
  parameters: {
    type: "object",
    properties: {
      outcomeType: { type: "string", enum: OutcomeType.options, description: "What the conversation achieved." },
    },
    required: ["outcomeType"],
  },
  input: z.object({ outcomeType: OutcomeType }),
  isAvailable: () => true,
  async execute({ outcomeType }, { config, state }) {
    // The harness, not the model, decides whether the conversation is really done.
    const missing = missingRequiredKeys(config, state.capturedData);
    if (missing.length > 0) {
      return { ok: false, error: `Cannot end yet: still missing required fields: ${missing.join(", ")}. Keep collecting them.` };
    }
    if (config.offeredTools.has("update_goal")) {
      const unresolved = config.goals.filter(
        (g) => g.priority === "primary" && !["achieved", "failed"].includes(state.goalProgress[g.id]?.status ?? "pending"),
      );
      if (unresolved.length > 0) {
        return {
          ok: false,
          error: `Cannot end yet: primary goals not resolved: ${unresolved.map((g) => g.id).join(", ")}. Work on them or mark them with update_goal.`,
        };
      }
    }
    state.terminal = { kind: "end", outcomeType };
    return { ok: true, data: { ended: true } };
  },
};

const handoffToHuman: AgentTool = {
  name: "handoff_to_human",
  description:
    "Pass the visitor to a human colleague when they ask for one, are upset, or you cannot help. After calling this, tell the visitor that someone will follow up.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "One sentence for the human who picks this up." } },
    required: ["reason"],
  },
  input: z.object({ reason: z.string().min(1).max(300) }),
  isAvailable: () => true,
  async execute({ reason }, { state }) {
    state.terminal = { kind: "handoff", reason };
    return { ok: true, data: { handedOff: true } };
  },
};

/** Emails the visitor has actually given us this conversation — the only addresses the CRM and calendar tools may act on. */
function capturedEmails(config: ToolConfig, captured: Record<string, unknown>): string[] {
  return config.requiredFields
    .filter((f) => f.type === "email")
    .map((f) => captured[f.key])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
}

const lookupCrmContact: AgentTool = {
  name: "lookup_crm_contact",
  description:
    "Check whether the visitor is already a known contact in the business's CRM, using the email they gave you. Returns only whether they exist and their first name — use it to greet returning customers, never to reveal other details.",
  parameters: {
    type: "object",
    properties: { email: { type: "string", description: "The visitor's own email, as they gave it to you." } },
    required: ["email"],
  },
  input: z.object({ email: z.string().email() }),
  isAvailable: (config) => config.connections.crm,
  async execute({ email }, { config, state, services }) {
    // Without this, a visitor could make the agent probe the CRM for anyone's email.
    if (!capturedEmails(config, state.capturedData).includes(email.toLowerCase())) {
      return { ok: false, error: "You can only look up the email address the visitor has given you in this conversation." };
    }
    const result = await services.lookupCrmContact(email);
    if (!result.success) return { ok: false, error: "The CRM lookup is unavailable right now. Carry on without it." };
    return { ok: true, data: result.found ? { found: true, firstName: result.firstName ?? null } : { found: false } };
  },
};

const MAX_RANGE_DAYS = 14;

const checkCalendarAvailability: AgentTool = {
  name: "check_calendar_availability",
  description:
    "See which times are already taken on the business's calendar within a date range (ISO 8601 with timezone). Returns busy intervals; any time outside them is free. Use it before offering the visitor meeting times.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start of the range, ISO 8601 date-time, e.g. 2026-12-01T09:00:00Z." },
      to: { type: "string", description: "End of the range, ISO 8601 date-time. At most 14 days after from." },
    },
    required: ["from", "to"],
  },
  input: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
  isAvailable: (config) => config.connections.calendar,
  async execute({ from, to }, { services }) {
    const start = new Date(from);
    const end = new Date(to);
    if (end <= start) return { ok: false, error: "`to` must be after `from`." };
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      return { ok: false, error: `Ask for at most ${MAX_RANGE_DAYS} days at a time.` };
    }
    const result = await services.getBusyIntervals(start, end);
    if (!result.success) return { ok: false, error: "The calendar is unavailable right now. Carry on without it." };
    // Only times, never event titles or attendees.
    return { ok: true, data: { busy: result.busy } };
  },
};

const MAX_BOOKING_DAYS_AHEAD = 90;

const bookMeeting: AgentTool = {
  name: "book_meeting",
  description:
    "Book a meeting on the business's calendar at a time the visitor has agreed to. The time is re-checked against the calendar, so it may be refused if just taken. Only tell the visitor it is booked if this tool succeeds.",
  parameters: {
    type: "object",
    properties: {
      startTime: { type: "string", description: "Meeting start, ISO 8601 date-time with timezone." },
      durationMinutes: { type: "number", description: "Length in minutes, 15 to 120. Omit for the default." },
      title: { type: "string", description: "Short meeting title." },
      attendeeEmail: { type: "string", description: "The visitor's own email, to send them the invite." },
    },
    required: ["startTime"],
  },
  input: z.object({
    startTime: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(15).max(120).optional(),
    title: z.string().min(1).max(120).optional(),
    attendeeEmail: z.string().email().optional(),
  }),
  defaultMaxCallsPerConversation: 2,
  isAvailable: (config) => config.connections.calendar,
  async execute({ startTime, durationMinutes, title, attendeeEmail }, { config, state, services }) {
    const start = new Date(startTime);
    const now = Date.now();
    if (start.getTime() <= now) return { ok: false, error: "That time is in the past. Ask the visitor for a future time." };
    if (start.getTime() > now + MAX_BOOKING_DAYS_AHEAD * 86_400_000) {
      return { ok: false, error: `Meetings can be booked at most ${MAX_BOOKING_DAYS_AHEAD} days ahead.` };
    }
    // Invites only ever go to an address the visitor gave us — never one the model made up or a visitor typed to spam a third party.
    if (attendeeEmail && !capturedEmails(config, state.capturedData).includes(attendeeEmail.toLowerCase())) {
      return { ok: false, error: "Invites can only be sent to the email the visitor has given you. Capture it first." };
    }
    const result = await services.bookSlot({ start, durationMinutes, title, attendeeEmail });
    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, data: { booked: true, start: result.start, end: result.end, eventId: result.eventId } };
  },
};

export const BUILT_IN_TOOLS: readonly AgentTool[] = [
  captureField,
  updateGoal,
  endConversation,
  handoffToHuman,
  lookupCrmContact,
  checkCalendarAvailability,
  bookMeeting,
];
