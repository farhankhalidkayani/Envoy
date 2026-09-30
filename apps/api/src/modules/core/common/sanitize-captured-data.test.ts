import { describe, expect, it } from "vitest";
import { sanitizeCapturedData } from "./sanitize-captured-data.js";

describe("sanitizeCapturedData", () => {
  it("replaces data: URL values with a short marker, leaves everything else untouched", () => {
    const out = sanitizeCapturedData({
      name: "Jane",
      budget: 500000,
      avatar: "data:image/png;base64," + "A".repeat(1000),
    });
    expect(out.name).toBe("Jane");
    expect(out.budget).toBe(500000);
    expect(out.avatar).toMatch(/^\[file: image\/png, 1KB — not forwarded\]$/);
  });

  it("leaves ordinary strings that merely start with 'data' alone", () => {
    const out = sanitizeCapturedData({ note: "data science is fun" });
    expect(out.note).toBe("data science is fun");
  });
});
