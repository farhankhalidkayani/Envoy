import type { ArmResult, Comparison, LoopResult } from "./runner.js";

export interface ReportMeta {
  /** The model serving the agent, e.g. "mock" or "groq". */
  provider: string;
  visitor: "rule" | "llm";
  seed: number;
  trialsPerRound: number;
  rounds: number;
  guardTrials: number;
  date: string;
  /** The exact command that reproduces this report. */
  command: string;
}

const pct = (x: number, places = 0) => `${(x * 100).toFixed(places)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pts`;
const ci = (i: { low: number; high: number }) => `${pct(i.low)}–${pct(i.high)}`;
const num = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));
const pText = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** True when the run can only show that the measurement works, not how a real model behaves with real people. */
export const isSynthetic = (m: ReportMeta) => m.provider === "mock" || m.visitor === "rule";

function armRow(a: ArmResult, change: string) {
  return `| ${cell(a.label)} | ${a.completed}/${a.n} = **${pct(a.completionRate)}** (${ci(a.completionCI)}) | ${num(a.meanTurnsToComplete)}${a.turnsCI ? ` (${num(a.turnsCI.low)}–${num(a.turnsCI.high)})` : ""} | ${pct(a.meanCapturePct)} | ${a.errored} | ${cell(change)} |`;
}

function cmpRow(c: Comparison) {
  return `| ${cell(c.from)} → ${cell(c.to)} | ${pp(c.completionDiff)} | ${pp(c.completionDiffCI.low)} to ${pp(c.completionDiffCI.high)} | ${c.improved} / ${c.worsened} | ${pText(c.p)} | **${c.verdict}** |`;
}

/** Renders a loop result as a self-contained Markdown report: the numbers, whether each change was real, and what the numbers can't tell you. */
export function renderReport(loop: LoopResult, meta: ReportMeta): string {
  const out: string[] = [];
  const first = loop.rounds[0]!;
  const last = loop.rounds.at(-1)!;
  const total = loop.cumulative.at(-1);

  out.push("# Improvement loop experiment", "");
  out.push(`- **Date:** ${meta.date}`, `- **Agent model:** ${meta.provider}`, `- **Visitors:** ${meta.visitor === "rule" ? "rule-based simulated visitors (deterministic)" : "language-model-played visitors"}`);
  out.push(`- **Design:** ${meta.trialsPerRound} simulated visitors per round, the *same* visitors every round (seed ${meta.seed}); up to ${meta.rounds} improvement rounds; ${meta.guardTrials} cooperative visitors confirm each change before it is adopted`, "");

  if (isSynthetic(meta)) {
    out.push(
      "> **Read this first: this is a synthetic run.** " +
        (meta.provider === "mock" ? "The agent is a scripted stand-in model, " : "") +
        (meta.visitor === "rule" ? "the visitors follow fixed rules, " : "") +
        "and the world was built so that one kind of visitor leaves when asked for a phone number without a reason. " +
        "The numbers below prove the **measurement and improvement machinery works** — it finds the problem, drafts a fix, checks it is safe, adopts it, and the result is measured with proper statistics. " +
        "They are **not evidence that a real model improves with real people.** For that, run the same experiment with a real model and language-model visitors (see *Reproduce*).",
      "",
    );
  }

  out.push("## Result", "");
  if (total) {
    out.push(
      `Completion went from **${pct(first.arm.completionRate)}** (${ci(first.arm.completionCI)}) to **${pct(last.arm.completionRate)}** (${ci(last.arm.completionCI)}) over ${loop.rounds.length - 1} round${loop.rounds.length === 2 ? "" : "s"}: ` +
        `**${pp(total.completionDiff)}** (95% CI ${pp(total.completionDiffCI.low)} to ${pp(total.completionDiffCI.high)}), exact paired test p ${total.p < 0.001 ? "< 0.001" : "= " + pText(total.p)} — **${total.verdict}**.`,
      "",
    );
  } else {
    out.push("No change was adopted, so there is nothing to compare — see *Why it stopped*.", "");
  }
  out.push("| Round | Completion (95% CI) | Msgs to finish (95% CI) | Fields captured | Errors | Change adopted after this round |", "|---|---|---|---|---|---|");
  for (const r of loop.rounds) out.push(armRow(r.arm, r.adopted ? r.adopted.title : r.rejected ? `rejected: ${r.rejected.reason}` : "—"));
  out.push("");

  if (loop.cumulative.length > 0) {
    out.push("## Was each change real?", "", "Every round meets the **same** visitors, so the comparison is paired: only visitors whose outcome flipped carry information (exact McNemar test). \"Improved / worsened\" counts those visitors.", "");
    out.push("| Comparison | Δ completion | 95% CI of Δ | Improved / worsened | p | Verdict |", "|---|---|---|---|---|---|");
    for (const c of loop.cumulative) out.push(cmpRow({ ...c, from: "baseline" }));
    if (loop.stepwise.length > 1) for (const c of loop.stepwise) out.push(cmpRow(c));
    out.push("");
  }

  out.push("## What the harness found and changed", "");
  for (const r of loop.rounds) {
    out.push(`**Round ${r.round}** — ${r.findings.length === 0 ? "no findings." : "findings:"}`);
    for (const f of r.findings) out.push(`- [${f.severity}] ${f.title}`);
    if (r.adopted) {
      out.push("", `Adopted: *${r.adopted.title}*. ${r.adopted.rationale}`, `Safety check: cooperative visitors completed ${r.adopted.guard.baselineCompleted}/${r.adopted.guard.n} before and ${r.adopted.guard.candidateCompleted}/${r.adopted.guard.n} after.`, "```json", JSON.stringify(r.adopted.changes, null, 2), "```");
    }
    if (r.rejected) out.push("", `Rejected: *${r.rejected.title}* — ${r.rejected.reason}.`);
    out.push("");
  }

  const why: Record<LoopResult["stopReason"], string> = {
    max_rounds: "It ran the requested number of rounds.",
    no_findings: "The last round had no findings left — nothing the detectors consider wrong.",
    no_new_findings: "Every remaining finding had already been tried. What is left is the part this kind of change can't fix (for example visitors who never share the field).",
    proposal_failed: "The model could not produce a usable proposal.",
    no_change: "The drafted change would not have altered the agent.",
    guard_rejected: "A drafted change failed the safety check and was not adopted.",
  };
  out.push("## Why it stopped", "", why[loop.stopReason], "");

  const errors = loop.rounds.reduce((n, r) => n + r.arm.errored, 0);
  out.push("## Limits of this experiment", "");
  out.push("- Visitors are simulated. They are a model of people, not people.");
  out.push("- Within one report, rounds reuse the same visitors on purpose (it removes visitor-to-visitor noise), but that also means results describe *this* sample of visitors; a different seed can be run to check.");
  out.push("- Changes are chosen and adopted automatically here, standing in for the person who approves each one in the product. The safety check is the same one the product runs.");
  if (errors > 0) out.push(`- ${errors} trial${errors === 1 ? "" : "s"} ended in a model error and counted as not completed.`);
  out.push("", "## Reproduce", "", "```", meta.command, "```", "");
  return out.join("\n");
}
