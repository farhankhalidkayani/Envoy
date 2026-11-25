/**
 * Small, dependency-free statistics for judging whether an agent really got better. Everything is deterministic
 * (the bootstrap takes a seeded generator) so a reported result can be reproduced exactly.
 */

/** mulberry32: a tiny seeded PRNG. Same seed, same sequence, on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for a proportion — well-behaved at 0%, 100% and small n, unlike the textbook normal interval. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe's interval for the difference of two independent proportions (p2 − p1), built from the two Wilson intervals. */
export function newcombeDiff(k1: number, n1: number, k2: number, n2: number, z = 1.96): Interval {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const a = wilson(k1, n1, z);
  const b = wilson(k2, n2, z);
  const d = p2 - p1;
  return {
    low: d - Math.sqrt((p2 - b.low) ** 2 + (a.high - p1) ** 2),
    high: d + Math.sqrt((b.high - p2) ** 2 + (p1 - a.low) ** 2),
  };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Two-sided two-proportion z-test with a pooled variance, for two INDEPENDENT groups. */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number {
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return k1 / n1 === k2 / n2 ? 1 : 0;
  return 2 * (1 - normalCdf(Math.abs((k2 / n2 - k1 / n1) / se)));
}

/**
 * Exact McNemar test for PAIRED yes/no outcomes — the same visitors meeting both versions. Only the discordant
 * pairs carry information: `improved` (no → yes) vs `worsened` (yes → no). Two-sided exact binomial p-value.
 * Much more powerful than an unpaired test when the visitors are the same, which is why the experiment pairs them.
 */
export function mcnemarExact(improved: number, worsened: number): number {
  const n = improved + worsened;
  if (n === 0) return 1;
  const k = Math.min(improved, worsened);
  // P(X <= k) for X ~ Binomial(n, 1/2), doubled, computed in log space to stay stable for large n.
  let logChoose = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** Percentile bootstrap confidence interval for a mean, with a seeded generator. */
export function bootstrapMeanCI(values: number[], seed: number, resamples = 2000, confidence = 0.95): Interval {
  if (values.length === 0) return { low: NaN, high: NaN };
  const random = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return { low: means[Math.floor(alpha * resamples)]!, high: means[Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1)]! };
}

/** Percentile bootstrap CI for the mean of paired differences (after − before), resampling pairs together. */
export function bootstrapPairedDiffCI(before: number[], after: number[], seed: number, resamples = 2000): Interval {
  if (before.length !== after.length) throw new Error("paired samples must be the same length");
  return bootstrapMeanCI(before.map((b, i) => after[i]! - b), seed, resamples);
}

export type Verdict = "improved" | "worse" | "no clear difference";

/** A change counts only if its 95% interval excludes zero AND the test agrees — otherwise it is "no clear difference", never "slightly better". */
export function verdict(diff: Interval, p: number): Verdict {
  if (p < 0.05 && diff.low > 0) return "improved";
  if (p < 0.05 && diff.high < 0) return "worse";
  return "no clear difference";
}
