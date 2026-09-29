import { describe, expect, it } from "vitest";
import { insertBlock, moveBlock, moveContainer, removeBlock, updateBlock, type BuilderAdapter } from "./tree.js";

type B = { id: string };
type C = { id: string; items: B[] };
const a: BuilderAdapter<C, B> = {
  containerId: (c) => c.id,
  blockId: (b) => b.id,
  blocks: (c) => c.items,
  withBlocks: (c, items) => ({ ...c, items }),
};
const ids = (cs: C[]) => cs.map((c) => `${c.id}:${c.items.map((b) => b.id).join(",")}`);
const start: C[] = [
  { id: "s1", items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  { id: "s2", items: [{ id: "d" }] },
  { id: "s3", items: [] },
];

describe("builder tree ops", () => {
  it("reorders within a container", () => {
    expect(ids(moveBlock(a, start, "a", "s1", 2))).toEqual(["s1:b,c,a", "s2:d", "s3:"]);
    expect(ids(moveBlock(a, start, "c", "s1", 0))).toEqual(["s1:c,a,b", "s2:d", "s3:"]);
  });

  it("moves across containers, including into an empty one", () => {
    expect(ids(moveBlock(a, start, "b", "s2", 0))).toEqual(["s1:a,c", "s2:b,d", "s3:"]);
    expect(ids(moveBlock(a, start, "b", "s3", 0))).toEqual(["s1:a,c", "s2:d", "s3:b"]);
  });

  it("insert clamps and appends", () => {
    expect(ids(insertBlock(a, start, { id: "x" }, "s2", 99))).toEqual(["s1:a,b,c", "s2:d,x", "s3:"]);
    expect(ids(insertBlock(a, start, { id: "x" }, "s1", 1))).toEqual(["s1:a,x,b,c", "s2:d", "s3:"]);
  });

  it("removes, updates, moves containers and never mutates input", () => {
    const snapshot = JSON.stringify(start);
    expect(ids(removeBlock(a, start, "d"))).toEqual(["s1:a,b,c", "s2:", "s3:"]);
    expect(updateBlock(a, start, "b", () => ({ id: "B" }))[0]!.items[1]!.id).toBe("B");
    expect(ids(moveContainer(start, 2, 0))).toEqual(["s3:", "s1:a,b,c", "s2:d"]);
    expect(moveBlock(a, start, "missing", "s1", 0)).toBe(start);
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
