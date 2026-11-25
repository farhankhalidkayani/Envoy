import { describe, expect, it } from "vitest";
import {
  WorkflowDef, delayMs, describeConditions, stepApplies, isConsentGiven, isInQuietHours, isStartKeyword, isStopKeyword, leadMatches,
  normalizeEmail, normalizePhone, quietHoursDelayMs, withSmsOptOutNotice,
} from "./workflow.js";

const base = { name: "Hot lead", trigger: { type: "conversation_completed" as const }, steps: [{ type: "send_sms" as const, body: "Hi {{name}}" }] };

describe("WorkflowDef", () => {
  it("fills in sensible defaults", () => {
    const w = WorkflowDef.parse(base);
    expect(w.conditions).toEqual({ match: "all", conditions: [] });
    expect(w.settings).toMatchObject({ emailField: "email", phoneField: "phone", timezone: "UTC", exitOnReply: true, quietHours: { enabled: true, startHour: 21, endHour: 8 } });
  });
  it("defaults an email step to the lead, and accepts a team address", () => {
    const [a, b] = WorkflowDef.parse({ ...base, steps: [{ type: "send_email", subject: "s", body: "b" }, { type: "send_email", to: "sales@acme.co", subject: "s", body: "b" }] }).steps;
    expect(a).toMatchObject({ to: "lead" });
    expect(b).toMatchObject({ to: "sales@acme.co" });
    expect(WorkflowDef.safeParse({ ...base, steps: [{ type: "send_email", to: "not-an-email", subject: "s", body: "b" }] }).success).toBe(false);
  });
  it("needs at least one message, and caps steps and total waiting", () => {
    expect(WorkflowDef.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, steps: [{ type: "wait", amount: 1, unit: "hours" }] }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, steps: Array(13).fill({ type: "send_sms", body: "x" }) }).success).toBe(false);
    const long = { type: "wait", amount: 40, unit: "days" };
    expect(WorkflowDef.safeParse({ ...base, steps: [long, long, base.steps[0]] }).success).toBe(false); // 80 days
    expect(WorkflowDef.safeParse({ ...base, steps: [long, base.steps[0]] }).success).toBe(true);
  });
  it("rejects a trigger filter that doesn't fit its type, and unknown time zones", () => {
    expect(WorkflowDef.safeParse({ ...base, trigger: { type: "conversation_completed", formId: "f" } }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, trigger: { type: "form_submitted", agentId: "a" } }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, trigger: { type: "form_submitted", formId: "f" } }).success).toBe(true);
    expect(WorkflowDef.safeParse({ ...base, settings: { timezone: "Mars/Olympus" } }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, steps: [{ type: "send_sms", body: "x".repeat(481) }] }).success).toBe(false);
  });
});

describe("leadMatches", () => {
  const lead = { budget: 8000, plan: "pro", note: "needs it URGENT" };
  it("qualifies everyone when there are no conditions", () => {
    expect(leadMatches({ match: "all", conditions: [] }, lead)).toBe(true);
  });
  it("all / any over captured fields", () => {
    const c = [{ field: "budget", op: "gt" as const, value: 5000 }, { field: "plan", op: "equals" as const, value: "starter" }];
    expect(leadMatches({ match: "all", conditions: c }, lead)).toBe(false);
    expect(leadMatches({ match: "any", conditions: c }, lead)).toBe(true);
    expect(leadMatches({ match: "all", conditions: [{ field: "note", op: "contains", value: "urgent" }] }, lead)).toBe(true);
    expect(leadMatches({ match: "all", conditions: [{ field: "phone", op: "is_empty" }] }, lead)).toBe(true);
  });
  it("can test the conversation outcome", () => {
    const c = { match: "all" as const, conditions: [{ field: "$outcome", op: "equals" as const, value: "demo_booking" }] };
    expect(leadMatches(c, lead, "demo_booking")).toBe(true);
    expect(leadMatches(c, lead, "complaint")).toBe(false);
    expect(leadMatches(c, lead, null)).toBe(false);
  });
});

describe("recipients", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["ada", "ada@", "@x.co", "a b@x.co", 5, null, undefined]) expect(normalizeEmail(bad)).toBeNull();
  });
  it("accepts only internationally written phone numbers", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("(+1) 415-555-0100")).toBe("+14155550100");
    expect(normalizePhone("0044 7700 900123")).toBe("+447700900123");
    for (const bad of ["07700 900123", "415-555-0100", "+0123456789", "+12345", "abc", "", 4155550100, null]) expect(normalizePhone(bad)).toBeNull();
  });
  it("treats only a clear yes as consent", () => {
    for (const yes of [true, "yes", "Y", " TRUE ", "1", "on", "I agree"]) expect(isConsentGiven(yes)).toBe(true);
    for (const no of [false, "no", "", "maybe", undefined, null, 0, 1]) expect(isConsentGiven(no)).toBe(false);
  });
});

describe("SMS keywords and notice", () => {
  it("recognises opt-out and opt-in keywords the way carriers do", () => {
    for (const w of ["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "cancel", "End", "QUIT", "STOPALL"]) expect(isStopKeyword(w), w).toBe(true);
    for (const w of ["please stop texting me", "stopping", "", "yes"]) expect(isStopKeyword(w), w).toBe(false);
    expect(isStartKeyword("start")).toBe(true);
    expect(isStartKeyword("UNSTOP")).toBe(true);
    expect(isStartKeyword("stop")).toBe(false);
  });
  it("adds the opt-out line unless the message already says STOP", () => {
    expect(withSmsOptOutNotice("Hi Ada")).toBe("Hi Ada\nReply STOP to opt out.");
    expect(withSmsOptOutNotice("Hi. Text STOP to opt out")).toBe("Hi. Text STOP to opt out");
  });
});

describe("quiet hours", () => {
  const settings = (over: object = {}, tz = "UTC") => ({ timezone: tz, quietHours: { enabled: true, startHour: 21, endHour: 8, ...over } });
  const at = (iso: string) => new Date(iso);

  it("wraps midnight: late evening and early morning are quiet, daytime is not", () => {
    for (const t of ["2030-03-04T21:00:00Z", "2030-03-04T23:59:00Z", "2030-03-05T03:00:00Z", "2030-03-05T07:59:00Z"]) expect(isInQuietHours(at(t), settings()), t).toBe(true);
    for (const t of ["2030-03-04T08:00:00Z", "2030-03-04T12:00:00Z", "2030-03-04T20:59:00Z"]) expect(isInQuietHours(at(t), settings()), t).toBe(false);
  });
  it("handles a window that doesn't wrap, a disabled window, and an empty one", () => {
    expect(isInQuietHours(at("2030-03-04T13:00:00Z"), settings({ startHour: 12, endHour: 14 }))).toBe(true);
    expect(isInQuietHours(at("2030-03-04T14:00:00Z"), settings({ startHour: 12, endHour: 14 }))).toBe(false);
    expect(isInQuietHours(at("2030-03-04T23:00:00Z"), settings({ enabled: false }))).toBe(false);
    expect(isInQuietHours(at("2030-03-04T23:00:00Z"), settings({ startHour: 9, endHour: 9 }))).toBe(false);
  });
  it("follows the lead's time zone, not the server's", () => {
    // 02:00 UTC is 21:00 the evening before in New York (winter) → quiet there, and 10:00 in Singapore → not.
    expect(isInQuietHours(at("2030-01-15T02:00:00Z"), settings({}, "America/New_York"))).toBe(true);
    expect(isInQuietHours(at("2030-01-15T02:00:00Z"), settings({}, "Asia/Singapore"))).toBe(false);
    expect(isInQuietHours(at("2030-01-15T02:00:00Z"), settings({}, "UTC"))).toBe(true);
  });
  it("holds a message until the window ends, exactly", () => {
    expect(quietHoursDelayMs(at("2030-03-04T12:00:00Z"), settings())).toBe(0);
    expect(quietHoursDelayMs(at("2030-03-05T03:00:00Z"), settings())).toBe(5 * 3_600_000); // 03:00 → 08:00
    expect(quietHoursDelayMs(at("2030-03-04T22:30:00Z"), settings())).toBe(9.5 * 3_600_000);
    expect(quietHoursDelayMs(at("2030-03-04T21:00:00Z"), settings())).toBe(11 * 3_600_000);
  });
  it("is right across a DST change and in half-hour zones", () => {
    // US spring-forward 2030-03-10 02:00 local. 05:00 UTC Mar 10 is 00:00 EST (quiet); morning ends at 08:00 local (EDT, UTC-4) = 12:00 UTC.
    const wait = quietHoursDelayMs(at("2030-03-10T05:00:00Z"), settings({}, "America/New_York"));
    expect(new Date(at("2030-03-10T05:00:00Z").getTime() + wait).toISOString()).toBe("2030-03-10T12:00:00.000Z");
    // India is UTC+5:30: 08:00 local = 02:30 UTC.
    const india = quietHoursDelayMs(at("2030-03-04T22:00:00Z"), settings({}, "Asia/Kolkata"));
    expect(new Date(at("2030-03-04T22:00:00Z").getTime() + india).toISOString()).toBe("2030-03-05T02:30:00.000Z");
  });
});

describe("delayMs", () => {
  it("converts each unit", () => {
    expect(delayMs({ type: "wait", amount: 5, unit: "minutes" })).toBe(300_000);
    expect(delayMs({ type: "wait", amount: 2, unit: "hours" })).toBe(7_200_000);
    expect(delayMs({ type: "wait", amount: 1, unit: "days" })).toBe(86_400_000);
  });
});

describe("conditional steps", () => {
  const sms = { type: "send_sms" as const, body: "Hi" };
  const cond = (field: string, op: "equals" | "gt" | "is_empty", value?: string | number) => ({ match: "all" as const, conditions: [{ field, op, value }] });

  it("any step may carry a condition", () => {
    const w = WorkflowDef.parse({ ...base, steps: [{ ...sms, when: cond("budget", "gt", 5000) }, { type: "wait", amount: 1, unit: "days", when: cond("plan", "equals", "pro") }, sms] });
    expect(w.steps[0]).toMatchObject({ when: { conditions: [{ field: "budget", op: "gt", value: 5000 }] } });
    expect(w.steps[1]).toMatchObject({ type: "wait" });
    expect(w.steps[2]).not.toHaveProperty("when");
  });

  it("'end here' needs a condition — otherwise it would silently cut off everything after it", () => {
    const exit = { type: "exit" as const };
    expect(WorkflowDef.safeParse({ ...base, steps: [sms, exit] }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, steps: [sms, { ...exit, when: { match: "all", conditions: [] } }] }).success).toBe(false);
    expect(WorkflowDef.safeParse({ ...base, steps: [sms, { ...exit, when: cond("customer", "equals", "yes") }, sms] }).success).toBe(true);
  });

  it("an end-here step isn't a message, so a workflow of only waits and exits is still empty", () => {
    expect(WorkflowDef.safeParse({ ...base, steps: [{ type: "exit", when: cond("a", "equals", "b") }] }).success).toBe(false);
  });

  it("decides per step, from the lead's data at that moment", () => {
    const step = { ...sms, when: cond("budget", "gt", 5000) };
    expect(stepApplies(step, { budget: 9000 })).toBe(true);
    expect(stepApplies(step, { budget: 100 })).toBe(false);
    expect(stepApplies(step, {})).toBe(false);
    expect(stepApplies(sms, {})).toBe(true); // no condition: always
    expect(stepApplies({ ...sms, when: { match: "all", conditions: [{ field: "$outcome", op: "equals", value: "complaint" }] } }, {}, "complaint")).toBe(true);
  });

  it("two steps with opposite conditions make an if/else", () => {
    const big = { ...sms, body: "VIP", when: cond("budget", "gt", 5000) };
    const small = { ...sms, body: "Standard", when: { match: "all" as const, conditions: [{ field: "budget", op: "lt" as const, value: 5001 }] } };
    for (const [lead, expected] of [[{ budget: 9000 }, ["VIP"]], [{ budget: 100 }, ["Standard"]]] as const) {
      expect([big, small].filter((s) => stepApplies(s, lead)).map((s) => s.body)).toEqual(expected);
    }
  });

  it("describes conditions in plain words", () => {
    expect(describeConditions({ match: "all", conditions: [{ field: "budget", op: "gt", value: 5000 }, { field: "plan", op: "equals", value: "pro" }] })).toBe("budget is more than 5000 and plan is pro");
    expect(describeConditions({ match: "any", conditions: [{ field: "$outcome", op: "equals", value: "complaint" }, { field: "phone", op: "is_empty" }] })).toBe("outcome is complaint or phone is empty");
    expect(describeConditions({ match: "all", conditions: [{ field: "email", op: "is_not_empty" }] })).toBe("email is not empty");
  });
});
