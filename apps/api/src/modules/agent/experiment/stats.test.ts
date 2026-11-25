import { describe, expect, it } from "vitest";
import { bootstrapMeanCI, bootstrapPairedDiffCI, mcnemarExact, mean, newcombeDiff, normalCdf, rng, twoProportionP, verdict, wilson } from "./stats.js";

const close = (a: number, b: number, tol = 0.002) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

describe("rng", () => {
  it("is reproducible and roughly uniform", () => {
    const a = rng(42);
    const b = rng(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(rng(1)()).not.toBe(rng(2)());
    const r = rng(7);
    const xs = Array.from({ length: 20_000 }, r);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    close(mean(xs), 0.5, 0.01);
  });
});

describe("normalCdf", () => {
  it("matches known values", () => {
    close(normalCdf(0), 0.5, 1e-6);
    close(normalCdf(1.96), 0.975, 1e-4);
    close(normalCdf(-1.96), 0.025, 1e-4);
    close(normalCdf(3), 0.99865, 1e-4);
  });
});

describe("wilson", () => {
  it("matches published values", () => {
    const w = wilson(81, 263); // Wilson's classic example
    close(w.low, 0.2553, 0.002);
    close(w.high, 0.3662, 0.002);
  });
  it("stays inside [0,1] and is sensible at the extremes", () => {
    const none = wilson(0, 20);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.1);
    const all = wilson(20, 20);
    expect(all.high).toBe(1);
    expect(all.low).toBeLessThan(0.9);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
  it("narrows as the sample grows", () => {
    const small = wilson(5, 10);
    const big = wilson(500, 1000);
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });
});

describe("newcombeDiff", () => {
  it("brackets the observed difference, and excludes zero for a big one", () => {
    const d = newcombeDiff(55, 100, 90, 100);
    expect(d.low).toBeLessThan(0.35);
    expect(d.high).toBeGreaterThan(0.35);
    expect(d.low).toBeGreaterThan(0.2);
  });
  it("includes zero when nothing changed", () => {
    const d = newcombeDiff(50, 100, 52, 100);
    expect(d.low).toBeLessThan(0);
    expect(d.high).toBeGreaterThan(0);
  });
});

describe("twoProportionP", () => {
  it("agrees with a hand calculation", () => {
    // 55/100 vs 90/100: pooled p=.725, se=.0632, z=5.54
    expect(twoProportionP(55, 100, 90, 100)).toBeLessThan(1e-6);
    close(twoProportionP(50, 100, 60, 100), 0.1552, 0.0005); // pooled p=.55, se=.0703, z=1.421
  });
  it("is 1 for identical rates and handles degenerate inputs", () => {
    expect(twoProportionP(10, 20, 10, 20)).toBeCloseTo(1, 6);
    expect(twoProportionP(0, 10, 0, 10)).toBe(1); // no variation at all: nothing to test
    expect(twoProportionP(10, 10, 10, 10)).toBe(1);
    expect(twoProportionP(0, 10, 10, 10)).toBeLessThan(1e-4); // z=4.47
  });
});

describe("mcnemarExact", () => {
  it("matches the exact binomial", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 5)).toBe(1);
    close(mcnemarExact(1, 9), 0.0215, 0.0005); // 2 * P(X<=1 | n=10) = 2 * 11/1024
    close(mcnemarExact(0, 10), 0.00195, 0.0001);
    expect(mcnemarExact(9, 1)).toBe(mcnemarExact(1, 9)); // symmetric
  });
  it("is stable for large counts", () => {
    expect(mcnemarExact(400, 380)).toBeGreaterThan(0.3);
    expect(mcnemarExact(1000, 100)).toBeLessThan(1e-100);
  });
  it("is more sensitive than the unpaired test when the same visitors are compared", () => {
    // 100 visitors, 40 flip from fail to complete, 3 flip the other way: clearly better, as the pairs show.
    expect(mcnemarExact(40, 3)).toBeLessThan(1e-7);
  });
});

describe("bootstrap", () => {
  it("is deterministic for a seed and brackets the mean", () => {
    const xs = Array.from({ length: 60 }, (_, i) => (i % 10) + 1);
    const a = bootstrapMeanCI(xs, 1);
    expect(bootstrapMeanCI(xs, 1)).toEqual(a);
    expect(a.low).toBeLessThan(mean(xs));
    expect(a.high).toBeGreaterThan(mean(xs));
    expect(bootstrapMeanCI(xs, 2)).not.toEqual(a);
  });
  it("collapses to the value when there is no variation, and is NaN for no data", () => {
    expect(bootstrapMeanCI([3, 3, 3, 3], 1)).toEqual({ low: 3, high: 3 });
    expect(bootstrapMeanCI([], 1).low).toBeNaN();
  });
  it("paired differences resample the pairs together", () => {
    const before = [5, 6, 7, 8, 9, 10, 11, 12];
    const after = before.map((b) => b - 2); // every visitor is exactly 2 better (fewer turns)
    expect(bootstrapPairedDiffCI(before, after, 3)).toEqual({ low: -2, high: -2 });
    expect(() => bootstrapPairedDiffCI([1], [1, 2], 1)).toThrow();
  });
});

describe("verdict", () => {
  it("only claims an effect when the interval and the test both say so", () => {
    expect(verdict({ low: 0.2, high: 0.5 }, 0.001)).toBe("improved");
    expect(verdict({ low: -0.5, high: -0.2 }, 0.001)).toBe("worse");
    expect(verdict({ low: -0.05, high: 0.4 }, 0.001)).toBe("no clear difference"); // interval spans zero
    expect(verdict({ low: 0.01, high: 0.4 }, 0.2)).toBe("no clear difference"); // test unconvinced
  });
});
