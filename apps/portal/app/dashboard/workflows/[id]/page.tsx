"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { Agent, Form, Workflow } from "@envoy/sdk";
import type { WorkflowDef } from "@envoy/types";
import { api } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth";
import { errorMessage } from "../../../../lib/errors";
import { emptyDraft, type Draft } from "../../../../lib/workflow-editor";
import { useToast } from "../../../../components/Toast";
import { RunsPanel } from "../../../../components/workflows/RunsPanel";
import { WorkflowEditor } from "../../../../components/workflows/WorkflowEditor";

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { showToast } = useToast();
  const isNew = id === "new";
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [forms, setForms] = useState<Form[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"edit" | "activity">("edit");
  const [ready, setReady] = useState(isNew);

  useEffect(() => {
    api.agents.list().then(setAgents).catch(() => {});
    api.forms.list().then(setForms).catch(() => {});
    if (!isNew) api.workflows.get(id).then((w) => { setWorkflow(w); setReady(true); }).catch((err) => setError(errorMessage(err)));
  }, [id, isNew]);

  async function save(def: WorkflowDef) {
    if (isNew) {
      const created = await api.workflows.create(def);
      showToast("Workflow saved as a draft.");
      router.replace(`/dashboard/workflows/${created.id}`);
    } else {
      setWorkflow(await api.workflows.update(id, def));
      showToast("Saved.");
    }
  }

  async function setStatus(status: "live" | "paused") {
    setBusy(true);
    setError(null);
    try {
      setWorkflow(await api.workflows.setStatus(id, status));
      showToast(status === "live" ? "Live — new leads that qualify will be followed up." : "Paused. Leads already in it were stopped.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !ready) return <div className="error-banner">{error}</div>;
  if (!ready) return <div className="card">Loading…</div>;

  const live = workflow?.status === "live";
  const isOwner = user?.role === "owner";
  const initial: Draft = workflow ? { name: workflow.name, trigger: workflow.trigger, conditions: workflow.conditions, steps: workflow.steps, settings: workflow.settings } : emptyDraft();

  return (
    <div style={{ maxWidth: 820 }}>
      <Link href="/dashboard/workflows" style={{ fontSize: 12.5 }}>← All follow-ups</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 14px" }}>
        <h1 className="page-title page-title--flush">{isNew ? "New follow-up" : workflow?.name}</h1>
        {workflow && (
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`pill ${live ? "pill-ok" : "pill-gray"}`}>{workflow.status}</span>
            {live ? (
              <button type="button" className="btn" disabled={busy} onClick={() => setStatus("paused")}>Pause</button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy || !isOwner} title={isOwner ? undefined : "Only the workspace owner can switch a workflow on"} onClick={() => setStatus("live")}>{workflow.status === "paused" ? "Resume" : "Go live"}</button>
            )}
          </span>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {live && <div className="card" style={{ marginBottom: 16, fontSize: 12.5 }}>This workflow is live, so it can&apos;t be edited — leads in progress follow the steps exactly as written. <b>Pause</b> it to make changes (leads currently in it will be stopped).</div>}
      {!isNew && (
        <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {(["edit", "activity"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t === "edit" ? "Workflow" : "Activity"}</button>)}
        </div>
      )}
      {tab === "edit" ? <WorkflowEditor key={workflow?.updatedAt ?? "new"} initial={initial} readOnly={live} agents={agents} forms={forms} onSave={save} /> : <RunsPanel workflowId={id} />}
    </div>
  );
}
