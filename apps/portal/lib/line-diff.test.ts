import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff";

const show = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind === "same" ? " " : l.kind === "added" ? "+" : "-"}${l.text}`);

describe("lineDiff", () => {
  it("marks everything the same when nothing changed", () => {
    expect(show("a\nb", "a\nb")).toEqual([" a", " b"]);
  });
  it("shows an appended paragraph as additions only", () => {
    expect(show("Book demos.", "Book demos.\n\nKeep replies short.")).toEqual([" Book demos.", "+", "+Keep replies short."]);
  });
  it("shows a replaced line as a removal and an addition, keeping the context", () => {
    expect(show("one\ntwo\nthree", "one\n2\nthree")).toEqual([" one", "-two", "+2", " three"]);
  });
  it("handles empty inputs on either side", () => {
    expect(show("", "x\ny")).toEqual(["+x", "+y"]);
    expect(show("x", "")).toEqual(["-x"]);
    expect(show("", "")).toEqual([]);
  });
  it("reports a reordering as moves rather than losing text", () => {
    const out = lineDiff("a\nb\nc", "c\na\nb");
    expect(out.filter((l) => l.kind !== "added").map((l) => l.text).join("")).toContain("a");
    expect(out.filter((l) => l.kind === "same").length).toBe(2);
  });
});
