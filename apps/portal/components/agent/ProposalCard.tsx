"use client";

import type { Agent, Proposal } from "@envoy/sdk";
import { lineDiff } from "../../lib/line-diff";

const STATUS: Record<Proposal["status"], { label: string; pill: string }> = {
  pending: { label: "not tested yet", pill: "pill-gray" },
  tested: { label: "tested", pill: "pill-warn" },
  approved: { label: "applied", pill: "pill-ok" },
  rejected: { label: "rejected", pill: "pill-gray" },
};

/** What a proposal would change, shown against what's live now. */
export function ChangeView({ proposal, agent }: { proposal: Proposal; agent: Agent }) {
  const c = proposal.changes;
  return (
    <div style={{ fontSize: 12.5 }}>
      {c.script !== undefined && (
        <div style={{ marginBottom: 8 }}>
          <b>Script</b>
          <pre style={{ margin: "4px 0", padding: 8, background: "var(--panel-hover)", borderRadius: 6, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12 }} aria-label="Script changes">
            {lineDiff(agent.script, c.script).map((l, i) => (
              <div key={i} style={{ background: l.kind === "added" ? "var(--ok-soft, #e3f4e8)" : l.kind === "removed" ? "var(--stop-soft)" : "transparent", color: l.kind === "removed" ? "var(--stop)" : undefined }}>
                {l.kind === "added" ? "+ " : l.kind === "removed" ? "− " : "  "}
                {l.text || " "}
              </div>
            ))}
          </pre>
        </div>
      )}
      {c.persona !== undefined && (
        <div style={{ marginBottom: 8 }}>
          <b>Persona</b>
          <div>{agent.spec.persona ? <><s style={{ color: "var(--stop)" }}>{agent.spec.persona}</s> → </> : null}<span>{c.persona || "(cleared)"}</span></div>
        </div>
      )}
      {c.fieldPrompts &&
        Object.entries(c.fieldPrompts).map(([key, hint]) => (
          <div key={key} style={{ marginBottom: 8 }}>
            <b>Hint for “{agent.requiredFields.find((f) => f.key === key)?.label ?? key}”</b>
            <div>{agent.requiredFields.find((f) => f.key === key)?.prompt ? <><s style={{ color: "var(--stop)" }}>{agent.requiredFields.find((f) => f.key === key)!.prompt}</s> → </> : null}{hint}</div>
          </div>
        ))}
      {c.addHardRules && (
        <div style={{ marginBottom: 8 }}>
          <b>New hard rules</b> <span style={{ color: "var(--ink-faint)" }}>(existing rules are never changed)</span>
          {c.addHardRules.map((r) => <div key={r.id}>+ <code>{r.id}</code>: {r.text} ({r.action})</div>)}
        </div>
      )}
    </div>
  );
}

export function ProposalCard({
  proposal,
  agent,
  isOwner,
  busy,
  onTest,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  agent: Agent;
  isOwner: boolean;
  busy: boolean;
  onTest(): void;
  onApprove(acknowledgeUntested: boolean): void;
  onReject(): void;
}) {
  const t = proposal.testResult;
  const decided = proposal.status === "approved" || proposal.status === "rejected";
  const untested = t !== null && t.scenarios.total === 0;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
        <strong style={{ fontSize: 13.5 }}>Proposed change</strong>
        <span>
          {proposal.stale && !decided && <span className="pill pill-stop" style={{ marginRight: 6 }} title={`Drafted for v${proposal.baseVersion}; the agent is now v${agent.version}`}>out of date</span>}
          <span className={`pill ${STATUS[proposal.status].pill}`}>{STATUS[proposal.status].label}{proposal.status === "approved" && proposal.appliedVersion ? ` as v${proposal.appliedVersion}` : ""}</span>
        </span>
      </div>
      <p style={{ fontSize: 12.5, marginBottom: 10 }}>{proposal.rationale}</p>
      <ChangeView proposal={proposal} agent={agent} />

      {t && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 8, fontSize: 12.5 }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Test results</strong>
          {t.scenarios.total === 0 ? (
            <p style={{ color: "var(--warn)" }}>This agent has no scenarios, so nothing checks that the change doesn&apos;t break existing behavior. Add some under Test agent → Scenarios.</p>
          ) : (
            <p>
              Scenarios: <b>{t.scenarios.baselinePassed}/{t.scenarios.total}</b> pass today → <b>{t.scenarios.candidatePassed}/{t.scenarios.total}</b> with this change
              {t.scenarios.fixed.length > 0 && <span style={{ color: "var(--ok, green)" }}> · fixes: {t.scenarios.fixed.join(", ")}</span>}
            </p>
          )}
          {t.scenarios.regressions.map((r) => (
            <div key={r.scenario} style={{ color: "var(--stop)", margin: "4px 0 4px 8px" }}>
              ✕ Breaks “{r.scenario}”
              {r.failed.map((f, i) => <div key={i} style={{ marginLeft: 12 }}>{f.check} — {f.detail}</div>)}
            </div>
          ))}
          {t.replay.total > 0 && (
            <p>Replaying {t.replay.total} real visitor{t.replay.total === 1 ? "" : "s"} who hit this problem: <b>{t.replay.baselineCompleted}</b> finished before, <b>{t.replay.candidateCompleted}</b> finish with this change.</p>
          )}
          <p>
            Hard rules: {t.hardRulesPreserved ? "all unchanged" : <b style={{ color: "var(--stop)" }}>altered — blocked</b>} ·{" "}
            {t.safe ? <span className="pill pill-ok">safe to apply</span> : <span className="pill pill-stop">can&apos;t be applied</span>}
          </p>
        </div>
      )}

      {!decided && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={busy || proposal.stale} onClick={onTest}>{t ? "Re-test" : "Test this change"}</button>
          {isOwner && (
            <button type="button" className="btn btn-primary" disabled={busy || proposal.stale || !t || !t.safe} onClick={() => onApprove(untested)} title={!t ? "Test it first" : undefined}>
              {untested ? "Apply without scenario checks" : "Approve & apply"}
            </button>
          )}
          {isOwner && <button type="button" className="btn" disabled={busy} onClick={onReject}>Reject</button>}
          {!isOwner && <span style={{ fontSize: 12, color: "var(--ink-faint)", alignSelf: "center" }}>Only the workspace owner can apply or reject.</span>}
        </div>
      )}
    </div>
  );
}
