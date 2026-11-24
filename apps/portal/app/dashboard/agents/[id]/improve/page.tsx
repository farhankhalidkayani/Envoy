"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent, AgentMetrics, Insight, Proposal } from "@envoy/sdk";
import { ApiError } from "@envoy/sdk";
import { api } from "../../../../../lib/api";
import { useAuth } from "../../../../../lib/auth";
import { errorMessage } from "../../../../../lib/errors";
import { useToast } from "../../../../../components/Toast";
import { ProposalCard } from "../../../../../components/agent/ProposalCard";

const SEVERITY_PILL = { critical: "pill-stop", warning: "pill-warn", info: "pill-gray" } as const;
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export default function ImprovePage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const { showToast } = useToast();
  const isOwner = user?.role === "owner";
  const [agent, setAgent] = useState<Agent | null>(null);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, m, i, p] = await Promise.all([
        api.agents.get(params.id),
        api.agents.improvement.metrics(params.id),
        api.agents.improvement.insights(params.id),
        api.agents.improvement.proposals(params.id),
      ]);
      setAgent(a); setMetrics(m); setInsights(i); setProposals(p);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setDisabled(true);
      else setError(errorMessage(err));
    }
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);

  async function run<T>(key: string, fn: () => Promise<T>, done?: string) {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (done) showToast(done);
      await load();
      return result;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (disabled) {
    return (
      <div style={{ maxWidth: 640 }}>
        <Link href={`/dashboard/agents/${params.id}`} style={{ fontSize: 12.5 }}>← Back</Link>
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Agent improvement isn&apos;t enabled for your account.</strong>
          <p style={{ fontSize: 13, marginTop: 6 }}>It analyses your real conversations and runs test conversations on your AI model, so it&apos;s switched on per account. Ask your administrator to enable it.</p>
        </div>
      </div>
    );
  }
  if (!agent || !metrics || !insights || !proposals) return error ? <div className="error-banner">{error}</div> : <div className="card">Loading…</div>;

  const current = metrics.versions.find((v) => v.version === agent.version);
  const open = insights.filter((i) => i.status === "open");
  const live = proposals.filter((p) => p.status === "pending" || p.status === "tested");
  const past = proposals.filter((p) => p.status === "approved" || p.status === "rejected");

  return (
    <div style={{ maxWidth: 860 }}>
      <Link href={`/dashboard/agents/${agent.id}`} style={{ fontSize: 12.5 }}>← Back to {agent.name}</Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>Improve {agent.name}</h1>
      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 14 }}>
        Looks at how this agent really performed, names what&apos;s going wrong, drafts a fix, and proves it on your scenarios before you decide. Nothing changes until you approve it.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Performance, last {metrics.days} days</strong>
        {metrics.versions.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No finished conversations yet. Once visitors use this agent, how it performs shows up here.</p>
        ) : (
          <table>
            <thead><tr><th>Version</th><th>Engaged</th><th>Completed</th><th>Left part-way</th><th>Completion</th><th>Avg messages</th><th>Handoffs</th><th>Replies blocked</th><th>Tool errors</th></tr></thead>
            <tbody>
              {[...metrics.versions].reverse().map((v) => (
                <tr key={v.version} style={v.version === agent.version ? { fontWeight: 600 } : undefined}>
                  <td>v{v.version}{v.version === agent.version && " (current)"}</td>
                  <td>{v.engaged}</td><td>{v.completed}</td><td>{v.abandoned}</td>
                  <td>{pct(v.completionRate)}</td><td>{v.avgTurnsToComplete ?? "—"}</td>
                  <td>{v.handoffs}</td><td>{v.blockedViolations}</td><td>{v.toolErrors}/{v.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {current && current.bounces > 0 && <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 6 }}>{current.bounces} visitor{current.bounces === 1 ? "" : "s"} left without saying anything — not counted against the agent.</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong style={{ fontSize: 13.5 }}>What&apos;s going wrong (v{agent.version})</strong>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => run("analyze", () => api.agents.improvement.analyze(agent.id), "Analysis updated.")}>
            {busy === "analyze" ? "Analysing…" : insights.length ? "Re-analyse" : "Analyse conversations"}
          </button>
        </div>
        {insights.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Nothing found yet. Findings need at least 8 conversations where visitors engaged; run the analysis once there&apos;s enough history.</p>}
        {insights.map((i) => (
          <div key={i.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0", opacity: i.status === "dismissed" ? 0.55 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span className={`pill ${SEVERITY_PILL[i.severity]}`}>{i.severity}</span>
              <b style={{ fontSize: 13 }}>{i.title}</b>
              {i.status === "dismissed" && <span className="pill pill-gray">dismissed</span>}
            </div>
            <p style={{ fontSize: 12.5, margin: "4px 0 6px" }}>{i.detail}</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "var(--ink-faint)" }}>Based on {i.evidence.count} of {i.evidence.total}</span>
              {i.status === "open" && (
                <>
                  <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} disabled={busy !== null} onClick={() => run(`propose-${i.id}`, () => api.agents.improvement.propose(agent.id, i.id), "Draft ready below.")}>
                    {busy === `propose-${i.id}` ? "Drafting…" : "Propose a fix"}
                  </button>
                  <button type="button" className="btn" style={{ fontSize: 12 }} disabled={busy !== null} onClick={() => run(`dismiss-${i.id}`, () => api.agents.improvement.setInsightStatus(agent.id, i.id, "dismissed"))}>Dismiss</button>
                </>
              )}
              {i.status === "dismissed" && <button type="button" className="btn" style={{ fontSize: 12 }} onClick={() => run(`reopen-${i.id}`, () => api.agents.improvement.setInsightStatus(agent.id, i.id, "open"))}>Reopen</button>}
            </div>
          </div>
        ))}
        {open.length === 0 && insights.length > 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginTop: 8 }}>All findings dismissed.</p>}
      </div>

      {live.length > 0 && <h2 style={{ fontSize: 15, margin: "20px 0 8px" }}>Waiting for your decision</h2>}
      {live.map((p) => (
        <ProposalCard
          key={p.id} proposal={p} agent={agent} isOwner={isOwner} busy={busy !== null}
          onTest={() => run(`test-${p.id}`, () => api.agents.improvement.test(agent.id, p.id), "Tested.")}
          onApprove={(ack) => run(`approve-${p.id}`, () => api.agents.improvement.approve(agent.id, p.id, ack), "Applied as a new version.")}
          onReject={() => run(`reject-${p.id}`, () => api.agents.improvement.reject(agent.id, p.id), "Rejected.")}
        />
      ))}
      {busy?.startsWith("test-") && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Running your scenarios on both versions and replaying real visitors — this can take a minute…</p>}

      {past.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Past proposals ({past.length})</summary>
          {past.map((p) => <ProposalCard key={p.id} proposal={p} agent={agent} isOwner={isOwner} busy onTest={() => {}} onApprove={() => {}} onReject={() => {}} />)}
        </details>
      )}
    </div>
  );
}
