"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkflowRun } from "@envoy/sdk";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

const PILL = { running: "pill-warn", completed: "pill-ok", stopped: "pill-gray", failed: "pill-stop" } as const;
const REASON: Record<string, string> = { replied: "the lead replied", cancelled: "cancelled", workflow_paused: "the workflow was paused", lead_deleted: "the lead's record was deleted", invalid_workflow: "the workflow definition is invalid", ended_early: "it reached an “end here” step" };

/** Every lead that has been through a workflow, and exactly what happened at each step. */
export function RunsPanel({ workflowId }: { workflowId: string }) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [open, setOpen] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await api.workflows.runs(workflowId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [workflowId]);
  useEffect(() => { void load(); }, [load]);

  async function show(run: WorkflowRun) {
    try {
      setOpen(await api.workflows.getRun(run.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function cancel(run: WorkflowRun) {
    try {
      await api.workflows.cancelRun(run.id);
      setOpen(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card">
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Activity</strong>
      {error && <div className="error-banner">{error}</div>}
      {!runs && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Loading…</p>}
      {runs?.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No leads have entered this workflow yet.</p>}
      {runs?.map((r) => (
        <div key={r.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0", fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`pill ${PILL[r.status]}`}>{r.status}</span>
            <span style={{ flex: 1 }}>{new Date(r.createdAt).toLocaleString()} · {r.sourceType === "conversation" ? "conversation" : "form submission"}{r.stopReason ? ` · stopped because ${REASON[r.stopReason] ?? r.stopReason}` : ""}</span>
            <button type="button" className="btn" onClick={() => (open?.id === r.id ? setOpen(null) : show(r))} style={{ fontSize: 12 }}>{open?.id === r.id ? "Hide" : "Details"}</button>
          </div>
          {open?.id === r.id && (
            <div style={{ margin: "8px 0 0 12px" }}>
              {open.logs?.length === 0 && <p style={{ color: "var(--ink-faint)" }}>Nothing has happened yet.</p>}
              {open.logs?.map((l) => (
                <div key={l.id} style={{ padding: "2px 0" }}>
                  <span className={`pill ${l.status === "sent" ? "pill-ok" : l.status === "failed" ? "pill-stop" : l.status === "skipped" ? "pill-warn" : "pill-gray"}`}>{l.status}</span>{" "}
                  Step {l.stepIndex + 1}: {l.type === "exit" ? "end here" : l.type.replace("send_", "").replace("_", " ")}{l.toMasked ? ` to ${l.toMasked}` : ""}{l.detail ? ` — ${l.detail}` : ""}
                </div>
              ))}
              {open.status === "running" && <button type="button" className="btn" onClick={() => cancel(open)} style={{ fontSize: 12, marginTop: 6 }}>Cancel this lead&apos;s sequence</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
