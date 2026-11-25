"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, type OptOut, type WorkflowList } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const PILL = { live: "pill-ok", paused: "pill-gray", draft: "pill-gray" } as const;

export default function WorkflowsPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<WorkflowList | null>(null);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [address, setAddress] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, outs] = await Promise.all([api.workflows.list(), api.workflows.optOuts()]);
      setData(list);
      setOptOuts(outs);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setDisabled(true);
      else setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function addOptOut(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.workflows.addOptOut(channel, address);
      setAddress("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function removeOptOut(o: OptOut) {
    try {
      await api.workflows.removeOptOut(o.id);
      showToast("Removed from the do-not-contact list.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function remove(id: string) {
    try {
      await api.workflows.remove(id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (disabled) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <strong>Follow-ups aren&apos;t enabled for your account.</strong>
        <p style={{ fontSize: 13, marginTop: 6 }}>They send email and text messages to your leads on your behalf, so they&apos;re switched on per account. Ask your administrator to enable them.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <h1 className="page-title page-title--flush">Follow-ups</h1>
        <Link href="/dashboard/workflows/new" className="btn btn-primary">+ New follow-up</Link>
      </div>
      <p style={{ color: "var(--ink-faint)", fontSize: 13, marginBottom: 16 }}>
        Automatically email and text your leads after a conversation or form, when they meet conditions you set — a thank-you now, a nudge tomorrow.
        {data && ` ${data.sentLast30Days} message${data.sentLast30Days === 1 ? "" : "s"} sent in the last 30 days.`}
      </p>
      {error && <div className="error-banner">{error}</div>}

      {!data && !error && <div className="card">Loading…</div>}
      {data?.workflows.length === 0 && <div className="card" style={{ fontSize: 13 }}>No follow-ups yet. Create one to start following up with leads automatically.</div>}
      {data?.workflows.map((w) => (
        <div key={w.id} className="card" style={{ marginBottom: 10, display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ flex: 1 }}>
            <Link href={`/dashboard/workflows/${w.id}`}><b>{w.name}</b></Link> <span className={`pill ${PILL[w.status]}`}>{w.status}</span>
            <span style={{ display: "block", fontSize: 12, color: "var(--ink-faint)" }}>
              {w.trigger.type === "conversation_completed" ? "After a conversation" : "After a form"} · {w.steps.filter((s) => s.type !== "wait").length} message{w.steps.filter((s) => s.type !== "wait").length === 1 ? "" : "s"}
              {w.runs && Object.keys(w.runs).length > 0 && ` · ${Object.entries(w.runs).map(([k, n]) => `${n} ${k}`).join(", ")}`}
            </span>
          </span>
          {w.status !== "live" && <button type="button" className="btn" onClick={() => remove(w.id)} aria-label={`Delete ${w.name}`} style={{ fontSize: 12 }}>Delete</button>}
        </div>
      ))}

      <div className="card" style={{ marginTop: 20 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Do-not-contact list</strong>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
          People here are never emailed or texted by a follow-up. Anyone who clicks unsubscribe or replies STOP is added automatically, and only they can undo that.
        </p>
        <form onSubmit={addOptOut} style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}><option value="email">Email</option><option value="sms">Text</option></select>
          <input aria-label="Address to add" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={channel === "email" ? "name@example.com" : "+44 7700 900123"} style={{ width: 240 }} />
          <button className="btn" disabled={!address.trim()}>Add</button>
        </form>
        {optOuts.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Nobody yet.</p>}
        {optOuts.map((o) => (
          <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--line)" }}>
            <span className="pill pill-gray">{o.channel}</span><code style={{ flex: 1 }}>{o.address}</code>
            <span style={{ color: "var(--ink-faint)" }}>{o.reason === "manual" ? "added by you" : o.reason === "stop" ? "replied STOP" : "unsubscribed"}</span>
            {o.reason === "manual" && <button type="button" className="btn" onClick={() => removeOptOut(o)} aria-label={`Remove ${o.address}`} style={{ fontSize: 12 }}>Remove</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
