import { describe, expect, it } from "vitest";
import { billingCycleWindow } from "./billing-cycle.js";

const iso = (d: Date) => d.toISOString();

describe("billingCycleWindow", () => {
  it("mid-cycle: start is this month's boundary, end is next month's", () => {
    const { start, end } = billingCycleWindow(15, new Date("2026-03-20T12:00:00Z"));
    expect(iso(start)).toBe("2026-03-15T00:00:00.000Z");
    expect(iso(end)).toBe("2026-04-15T00:00:00.000Z");
  });

  it("before this month's boundary: window is still the previous month's cycle", () => {
    const { start, end } = billingCycleWindow(15, new Date("2026-03-05T00:00:00Z"));
    expect(iso(start)).toBe("2026-02-15T00:00:00.000Z");
    expect(iso(end)).toBe("2026-03-15T00:00:00.000Z");
  });

  it("exactly on the boundary instant: that instant starts the new cycle", () => {
    const { start } = billingCycleWindow(15, new Date("2026-03-15T00:00:00.000Z"));
    expect(iso(start)).toBe("2026-03-15T00:00:00.000Z");
  });

  it("day 31: Jan 31 has passed but Feb's clamped 28th hasn't, so the cycle is still Jan31→Feb28", () => {
    const { start, end } = billingCycleWindow(31, new Date("2026-02-20T00:00:00Z"));
    expect(iso(start)).toBe("2026-01-31T00:00:00.000Z");
    expect(iso(end)).toBe("2026-02-28T00:00:00.000Z"); // clamped, not Mar 3
  });

  it("day 31 clamps to Feb 29 in a leap year", () => {
    const { start, end } = billingCycleWindow(31, new Date("2028-02-20T00:00:00Z"));
    expect(iso(start)).toBe("2028-01-31T00:00:00.000Z");
    expect(iso(end)).toBe("2028-02-29T00:00:00.000Z");
  });

  it("day 31, now past Feb's clamped boundary: the cycle has rolled to Feb28→Mar31", () => {
    const { start, end } = billingCycleWindow(31, new Date("2026-03-01T00:00:00Z"));
    expect(iso(start)).toBe("2026-02-28T00:00:00.000Z");
    expect(iso(end)).toBe("2026-03-31T00:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    const { start, end } = billingCycleWindow(1, new Date("2027-01-01T00:00:00Z"));
    expect(iso(start)).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(end)).toBe("2027-02-01T00:00:00.000Z");
    const prev = billingCycleWindow(15, new Date("2027-01-05T00:00:00Z"));
    expect(iso(prev.start)).toBe("2026-12-15T00:00:00.000Z");
  });
});
