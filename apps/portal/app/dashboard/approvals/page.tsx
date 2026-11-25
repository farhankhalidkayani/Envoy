"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ApprovalRequest } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const STATUS_PILL = { pending: "pill-warn", approved: "pill-ok", rejected: "pill-gray", expired: "pill-gray", stale: "pill-gray", failed: "pill-stop" } as const;

function hoursLeft(iso: string) {
  const h = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
  return h <= 1 ? "less than an hour" : `${h} hours`;
}

/**
 * Things an AI assistant (or anyone with an API token) has asked you to approve. Each is something that only a
 * person may do. What you read here was built by the system from the agent's real state; the requester's own
 * explanation appears separately, as an unverified quote.
 */
export default function ApprovalsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isOwner = user?.role === "owner";
  const [items, setItems] = useState<ApprovalRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.approvals.list());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(a: ApprovalRequest, action: "approve" | "reject") {
    setBusy(a.id);
    setError(null);
    try {
      await (action === "approve" ? api.approvals.approve(a.id) : api.approvals.reject(a.id));
      showToast(action === "approve" ? "Approved and carried out." : "Rejected. Nothing was changed.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      await load();
    }
  }

  const pending = (items ?? []).filter((a) => a.status === "pending");
  const decided = (items ?? []).filter((a) => a.status !== "pending");

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 className="page-title">Approvals</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 13, marginBottom: 16 }}>
        Some things only a person may do — publish an agent, change its hard rules, give it access to your CRM or calendar. When an AI assistant needs one, it
        asks here. Nothing happens until you approve it, and an approval carries out exactly what you see below, once, as you.
      </p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!isOwner && <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>Only the workspace owner can approve or reject requests. You can see what's waiting.</div>}
      {!items && !error && <div className="card">Loading…</div>}
      {items && pending.length === 0 && <div className="card" style={{ fontSize: 13 }}>Nothing is waiting for you.</div>}

      {pending.map((a) => (
        <div key={a.id} className="card" style={{ marginBottom: 14, borderColor: a.summary?.warnings.length ? "var(--warn)" : undefined }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <strong style={{ fontSize: 14 }}>{a.summary?.title ?? a.kindLabel}</strong>
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>asked by <b>{a.requestedBy}</b> · expires in {hoursLeft(a.expiresAt)}</span>
          </div>
          {a.stale && (
            <p style={{ color: "var(--stop)", fontSize: 12.5, margin: "8px 0" }}>
              <b>Out of date.</b> “{a.agentName}” changed (version {a.baseVersion} → {a.currentVersion}) after this was requested, so approving it would not be what was reviewed. Reject it and ask again.
            </p>
          )}
          <ul style={{ margin: "10px 0", paddingLeft: 18, fontSize: 13 }}>
            {a.summary?.lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
          {a.summary?.warnings.map((w, i) => (
            <div key={i} style={{ background: "var(--warn-soft)", color: "var(--warn)", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, marginBottom: 6 }}>⚠ {w}</div>
          ))}
          {a.reason && (
            <blockquote style={{ margin: "10px 0", padding: "6px 12px", borderLeft: "3px solid var(--line)", fontSize: 12.5, color: "var(--ink-faint)" }}>
              <span style={{ display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>{a.requestedBy}&apos;s reason — their words, not verified</span>
              {a.reason}
            </blockquote>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            {isOwner && <button type="button" className="btn btn-primary" disabled={busy === a.id || a.stale} onClick={() => decide(a, "approve")}>Approve</button>}
            {isOwner && <button type="button" className="btn" disabled={busy === a.id} onClick={() => decide(a, "reject")}>Reject</button>}
            <Link href={`/dashboard/agents/${a.agentId}`} style={{ fontSize: 12.5 }}>Open “{a.agentName}”</Link>
          </div>
        </div>
      ))}

      {decided.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Earlier requests ({decided.length})</summary>
          {decided.map((a) => (
            <div key={a.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0", fontSize: 12.5 }}>
              <span className={`pill ${STATUS_PILL[a.status]}`}>{a.status}</span> <b>{a.kindLabel}</b> — “{a.agentName}”, asked by {a.requestedBy}, {new Date(a.createdAt).toLocaleString()}
              {a.note && <span style={{ color: "var(--ink-faint)" }}> · {a.note}</span>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
