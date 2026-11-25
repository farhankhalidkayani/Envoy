# Improvement loop experiment

- **Date:** 2026-11-24
- **Agent model:** mock
- **Visitors:** rule-based simulated visitors (deterministic)
- **Design:** 200 simulated visitors per round, the *same* visitors every round (seed 20260101); up to 4 improvement rounds; 12 cooperative visitors confirm each change before it is adopted

> **Read this first: this is a synthetic run.** The agent is a scripted stand-in model, the visitors follow fixed rules, and the world was built so that one kind of visitor leaves when asked for a phone number without a reason. The numbers below prove the **measurement and improvement machinery works** — it finds the problem, drafts a fix, checks it is safe, adopts it, and the result is measured with proper statistics. They are **not evidence that a real model improves with real people.** For that, run the same experiment with a real model and language-model visitors (see *Reproduce*).

## Result

Completion went from **58%** (51%–65%) to **90%** (84%–93%) over 1 round: **+31.5 pts** (95% CI +23.2 pts to +39.3 pts), exact paired test p < 0.001 — **improved**.

| Round | Completion (95% CI) | Msgs to finish (95% CI) | Fields captured | Errors | Change adopted after this round |
|---|---|---|---|---|---|
| baseline | 116/200 = **58%** (51%–65%) | 4.0 (4.0–4.0) | 86% | 0 | Visitors leave when asked for “Phone” |
| round 1 | 179/200 = **90%** (84%–93%) | 4.0 (4.0–4.0) | 96% | 0 | — |

## Was each change real?

Every round meets the **same** visitors, so the comparison is paired: only visitors whose outcome flipped carry information (exact McNemar test). "Improved / worsened" counts those visitors.

| Comparison | Δ completion | 95% CI of Δ | Improved / worsened | p | Verdict |
|---|---|---|---|---|---|
| baseline → round 1 | +31.5 pts | +23.2 pts to +39.3 pts | 63 / 0 | < 0.001 | **improved** |

## What the harness found and changed

**Round 0** — findings:
- [critical] Visitors leave when asked for “Phone”

Adopted: *Visitors leave when asked for “Phone”*. Visitors leave when asked for phone. Telling them why it is needed should make asking for it feel reasonable.
Safety check: cooperative visitors completed 12/12 before and 12/12 after.
```json
{
  "fieldPrompts": {
    "phone": "Briefly explain why you need this and how it will be used before asking for it."
  }
}
```

**Round 1** — findings:
- [critical] Visitors leave when asked for “Phone”

## Why it stopped

Every remaining finding had already been tried. What is left is the part this kind of change can't fix (for example visitors who never share the field).

## Limits of this experiment

- Visitors are simulated. They are a model of people, not people.
- Within one report, rounds reuse the same visitors on purpose (it removes visitor-to-visitor noise), but that also means results describe *this* sample of visitors; a different seed can be run to check.
- Changes are chosen and adopted automatically here, standing in for the person who approves each one in the product. The safety check is the same one the product runs.

## Reproduce

```
LLM_PROVIDER=mock EXPERIMENT_VISITOR=rule EXPERIMENT_TRIALS=200 EXPERIMENT_ROUNDS=4 EXPERIMENT_SEED=20260101 pnpm --filter @envoy/api experiment
```
