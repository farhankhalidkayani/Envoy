import { describe, expect, it } from "vitest";
import { WidgetConfig } from "./widget-config.js";

describe("WidgetConfig", () => {
  it("defaults quickReplies to an empty list", () => {
    expect(WidgetConfig.parse({}).quickReplies).toEqual([]);
  });

  it("accepts up to 6 quick replies and rejects a 7th", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, label: `Q${i}`, message: `M${i}` }));
    expect(WidgetConfig.parse({ quickReplies: six }).quickReplies).toHaveLength(6);
    expect(WidgetConfig.safeParse({ quickReplies: [...six, { id: "q7", label: "Q7", message: "M7" }] }).success).toBe(
      false,
    );
  });

  it("rejects a quick reply missing a label or message", () => {
    expect(WidgetConfig.safeParse({ quickReplies: [{ id: "q1", label: "", message: "hi" }] }).success).toBe(false);
    expect(WidgetConfig.safeParse({ quickReplies: [{ id: "q1", label: "Hi", message: "" }] }).success).toBe(false);
  });
});
