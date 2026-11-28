import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("returns to a path on this site after sign-in", () => {
    expect(safeNext("?next=%2Foauth%2Fauthorize%3Fclient_id%3Dc1%26state%3Dx")).toBe("/oauth/authorize?client_id=c1&state=x");
  });
  it.each(["?next=https%3A%2F%2Fevil.example", "?next=%2F%2Fevil.example", "?next=%2F%5Cevil.example", "?next=javascript%3Aalert(1)", "", "?next="])("never leaves the site: %s → /dashboard", (q) => {
    expect(safeNext(q)).toBe("/dashboard");
  });
});
