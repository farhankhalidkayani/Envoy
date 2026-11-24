import { describe, expect, it, vi } from "vitest";
import { AgentSpec } from "@envoy/types";
import { RunState } from "./run-state.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolServices } from "./tool.js";

const fields = [{ key: "email", label: "Email", type: "email" as const, required: true }];
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function setup(opts: { tools?: unknown[]; crm?: boolean; calendar?: boolean; captured?: Record<string, unknown>; services?: Partial<ToolServices> } = {}) {
  const registry = new ToolRegistry();
  const spec = AgentSpec.parse({ tools: opts.tools ?? [] });
  const base = { requiredFields: fields, goals: [], connections: { crm: opts.crm ?? true, calendar: opts.calendar ?? true } };
  const tools = registry.resolve(spec, base);
  const toolConfig = registry.toolConfig(tools, base);
  const state = new RunState({ ...(opts.captured ?? {}) }, {}, {});
  const services: ToolServices = {
    lookupCrmContact: vi.fn(async () => ({ success: true, found: true, firstName: "Ada" })),
    getBusyIntervals: vi.fn(async () => ({ success: true as const, busy: [{ start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z" }] })),
    bookSlot: vi.fn(async (r) => ({ success: true as const, eventId: "evt1", start: r.start.toISOString(), end: new Date(r.start.getTime() + 1_800_000).toISOString() })),
    ...opts.services,
  };
  const run = (name: string, args: Record<string, unknown>) =>
    registry.execute({ tools, call: { id: "c", name, arguments: args }, spec, toolConfig, state, services, timeoutMs: 1000 });
  return { tools, state, services, run, names: tools.map((t) => t.name) };
}
const ALL = [{ name: "lookup_crm_contact" }, { name: "check_calendar_availability" }, { name: "book_meeting" }];

describe("opt-in integration tools: availability", () => {
  it("are never offered unless the tenant opts in", () => {
    expect(setup().names).not.toContain("book_meeting");
    expect(setup().names).not.toContain("lookup_crm_contact");
  });

  it("are offered when opted in AND the matching system is connected", () => {
    expect(setup({ tools: ALL }).names).toEqual(expect.arrayContaining(["lookup_crm_contact", "check_calendar_availability", "book_meeting"]));
    const noCrm = setup({ tools: ALL, crm: false }).names;
    expect(noCrm).not.toContain("lookup_crm_contact");
    expect(noCrm).toContain("book_meeting");
    expect(setup({ tools: ALL, calendar: false }).names).not.toContain("book_meeting");
  });

  it("an explicit enabled:false keeps them off", () => {
    expect(setup({ tools: [{ name: "book_meeting", enabled: false }] }).names).not.toContain("book_meeting");
  });
});

describe("lookup_crm_contact", () => {
  it("returns only found + first name, for the email the visitor gave", async () => {
    const t = setup({ tools: ALL, captured: { email: "ada@example.com" } });
    const out = await t.run("lookup_crm_contact", { email: "ADA@example.com" });
    expect(out.outcome).toEqual({ ok: true, data: { found: true, firstName: "Ada" } });
  });

  it("refuses to probe the CRM for an email the visitor did not give", async () => {
    const t = setup({ tools: ALL, captured: { email: "ada@example.com" } });
    const out = await t.run("lookup_crm_contact", { email: "ceo@bigcorp.com" });
    expect(out.outcome).toMatchObject({ ok: false });
    expect(t.services.lookupCrmContact).not.toHaveBeenCalled();
  });

  it("hides provider errors from the model", async () => {
    const t = setup({
      tools: ALL,
      captured: { email: "a@b.co" },
      services: { lookupCrmContact: async () => ({ success: false, error: "HubSpot API error 500: secret internals" }) },
    });
    const out = await t.run("lookup_crm_contact", { email: "a@b.co" });
    expect(JSON.stringify(out.outcome)).not.toContain("secret internals");
    expect(out.outcome.ok).toBe(false);
  });
});

describe("check_calendar_availability", () => {
  it("returns busy intervals only", async () => {
    const t = setup({ tools: ALL });
    const out = await t.run("check_calendar_availability", { from: future(1), to: future(2) });
    expect(out.outcome).toMatchObject({ ok: true, data: { busy: [{ start: expect.any(String), end: expect.any(String) }] } });
  });

  it("rejects inverted and over-long ranges and non-ISO dates", async () => {
    const t = setup({ tools: ALL });
    expect((await t.run("check_calendar_availability", { from: future(2), to: future(1) })).outcome.ok).toBe(false);
    expect((await t.run("check_calendar_availability", { from: future(1), to: future(30) })).outcome.ok).toBe(false);
    expect((await t.run("check_calendar_availability", { from: "tomorrow", to: "next week" })).outcome.ok).toBe(false);
    expect(t.services.getBusyIntervals).not.toHaveBeenCalled();
  });
});

describe("book_meeting", () => {
  it("books a future slot", async () => {
    const t = setup({ tools: ALL, captured: { email: "a@b.co" } });
    const when = future(3);
    const out = await t.run("book_meeting", { startTime: when, attendeeEmail: "a@b.co", durationMinutes: 30 });
    expect(out.outcome).toMatchObject({ ok: true, data: { booked: true, eventId: "evt1" } });
    expect(t.services.bookSlot).toHaveBeenCalledWith(expect.objectContaining({ attendeeEmail: "a@b.co", durationMinutes: 30 }));
  });

  it("refuses past times, far-future times and out-of-range durations", async () => {
    const t = setup({ tools: ALL });
    expect((await t.run("book_meeting", { startTime: future(-1) })).outcome).toMatchObject({ ok: false });
    expect((await t.run("book_meeting", { startTime: future(200) })).outcome).toMatchObject({ ok: false });
    expect((await t.run("book_meeting", { startTime: future(3), durationMinutes: 600 })).outcome).toMatchObject({ ok: false });
    expect(t.services.bookSlot).not.toHaveBeenCalled();
  });

  it("only invites the email the visitor actually gave", async () => {
    const t = setup({ tools: ALL, captured: { email: "a@b.co" } });
    const out = await t.run("book_meeting", { startTime: future(3), attendeeEmail: "victim@else.com" });
    expect(out.outcome).toMatchObject({ ok: false });
    expect(t.services.bookSlot).not.toHaveBeenCalled();
  });

  it("surfaces a taken slot so the agent can offer another", async () => {
    const t = setup({
      tools: ALL,
      services: { bookSlot: async () => ({ success: false as const, error: "That time is no longer available. Offer the visitor another slot." }) },
    });
    expect((await t.run("book_meeting", { startTime: future(3) })).outcome).toEqual({
      ok: false,
      error: "That time is no longer available. Offer the visitor another slot.",
    });
  });

  it("is capped at 2 bookings per conversation by default, and the tenant can tighten it", async () => {
    const t = setup({ tools: ALL });
    expect((await t.run("book_meeting", { startTime: future(3) })).outcome.ok).toBe(true);
    expect((await t.run("book_meeting", { startTime: future(4) })).outcome.ok).toBe(true);
    expect((await t.run("book_meeting", { startTime: future(5) })).outcome.ok).toBe(false);

    const one = setup({ tools: [{ name: "book_meeting", enabled: true, maxCallsPerConversation: 1 }, { name: "check_calendar_availability" }] });
    expect((await one.run("book_meeting", { startTime: future(3) })).outcome.ok).toBe(true);
    expect((await one.run("book_meeting", { startTime: future(4) })).outcome.ok).toBe(false);
  });
});
