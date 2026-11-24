"use client";

import { useCallback, useEffect, useState } from "react";
import type { Agent, ModelCredential, Scenario, ScenarioRunReport, ScenarioStatus } from "@envoy/sdk";
import type { ScenarioDef } from "@envoy/types";
import { PROVIDER_LABELS } from "@envoy/types";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useToast } from "../Toast";
import { ScenarioEditor } from "./ScenarioEditor";

function StatusPill({ s }: { s: Scenario }) {
  if (!s.lastRun) return <span className="pill pill-gray">not run</span>;
  if (!s.lastRun.onCurrentVersion) return <span className="pill pill-gray" title={`Last run was on v${s.lastRun.agentVersion}`}>not run on this version</span>;
  return s.lastRun.passed ? <span className="pill pill-ok">passing</span> : <span className="pill pill-stop">failing</span>;
}

export function ScenarioManager({ agent, refreshKey }: { agent: Agent; refreshKey: number }) {
  const { showToast } = useToast();
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [status, setStatus] = useState<ScenarioStatus | null>(null);
  const [creds, setCreds] = useState<ModelCredential[]>([]);
  const [editing, setEditing] = useState<Scenario | "new" | null>(null);
  const [report, setReport] = useState<ScenarioRunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareCred, setCompareCred] = useState("");
  const [compareModel, setCompareModel] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, st, c] = await Promise.all([api.agents.scenarios.list(agent.id), api.agents.scenarios.status(agent.id), api.models.listCredentials()]);
      setScenarios(list); setStatus(st); setCreds(c.filter((k) => k.status === "active"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [agent.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function run(opts: Parameters<typeof api.agents.scenarios.run>[1]) {
    setRunning(true); setError(null); setReport(null);
    try {
      setReport(await api.agents.scenarios.run(agent.id, opts));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  const compare = () => {
    const cred = creds.find((c) => c.id === compareCred);
    if (!cred || !compareModel.trim()) return setError("Pick a key and enter the model to compare against.");
    void run({
      variants: [
        { label: "Current setup" },
        { label: `${cred.label} · ${compareModel.trim()} (${PROVIDER_LABELS[cred.provider]})`, models: { default: { credentialId: cred.id, model: compareModel.trim() } } },
      ],
    });
  };

  async function save(def: ScenarioDef) {
    if (editing && editing !== "new") await api.agents.scenarios.update(agent.id, editing.id, def);
    else await api.agents.scenarios.create(agent.id, def);
    setEditing(null);
    showToast("Scenario saved.");
    await load();
  }

  async function remove(s: Scenario) {
    try {
      await api.agents.scenarios.remove(agent.id, s.id);
      showToast("Scenario deleted.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const failed = (variant: string, id: string) => report?.results.find((r) => r.variant === variant && r.scenarioId === id);

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <strong style={{ fontSize: 13.5 }}>Scenarios</strong>
            {status && status.total > 0 && (
              <span style={{ fontSize: 12.5, color: "var(--ink-faint)", marginLeft: 10 }}>
                v{status.agentVersion}: {status.passing} passing · {status.failing} failing · {status.notRun} not run
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => setEditing("new")}>+ New scenario</button>
            <button type="button" className="btn btn-primary" disabled={running || !scenarios?.length} onClick={() => run({})}>{running ? "Running…" : "Run all"}</button>
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "6px 0 0" }}>
          A scenario is a scripted visitor plus what must be true afterwards. Run them before you publish a change — or against another model — to see exactly what broke.
          Runs use your AI model (and count toward its usage) but create no real conversations or leads.
        </p>
      </div>

      {editing && (
        <ScenarioEditor
          initial={editing === "new" ? undefined : { name: editing.name, description: editing.description ?? undefined, turns: editing.turns, expect: editing.expect as ScenarioDef["expect"], sandbox: editing.sandbox as ScenarioDef["sandbox"] }}
          goals={agent.spec.goals}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {!scenarios && !error && <div className="card">Loading…</div>}
      {scenarios?.length === 0 && !editing && <div className="card" style={{ fontSize: 13 }}>No scenarios yet. Create one, or save a playground conversation as a scenario.</div>}
      {scenarios?.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span><b>{s.name}</b> <StatusPill s={s} /> <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>{s.turns.length} visitor message{s.turns.length === 1 ? "" : "s"}</span></span>
            <span style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn" disabled={running} onClick={() => run({ scenarioIds: [s.id] })} style={{ fontSize: 12 }}>Run</button>
              <button type="button" className="btn" onClick={() => setEditing(s)} style={{ fontSize: 12 }}>Edit</button>
              <button type="button" className="btn" onClick={() => remove(s)} aria-label={`Delete ${s.name}`} style={{ fontSize: 12 }}>Delete</button>
            </span>
          </div>
        </div>
      ))}

      {creds.length > 0 && scenarios && scenarios.length > 0 && (
        <div className="card" style={{ margin: "16px 0" }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Compare with another model</strong>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
            Runs every scenario on your current setup and again on the model below, so you can see whether a stronger (or cheaper) model changes the result.
            Your agent itself is not changed.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Key to compare with" value={compareCred} onChange={(e) => setCompareCred(e.target.value)} style={{ width: 200 }}>
              <option value="">Choose a key…</option>{creds.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input aria-label="Model to compare with" value={compareModel} onChange={(e) => setCompareModel(e.target.value)} placeholder="model name" style={{ width: 220 }} />
            <button type="button" className="btn" disabled={running} onClick={compare}>Compare</button>
          </div>
        </div>
      )}

      {report && (
        <div className="card" style={{ marginTop: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Results (agent v{report.agentVersion})</strong>
          <table>
            <thead><tr><th>Setup</th><th>Passed</th><th>Tokens in / out</th><th>Avg time</th></tr></thead>
            <tbody>
              {report.variants.map((v) => (
                <tr key={v.label}>
                  <td>{v.label}</td>
                  <td><span className={`pill ${v.passed === v.total ? "pill-ok" : "pill-stop"}`}>{v.passed} / {v.total}</span></td>
                  <td>{v.inputTokens.toLocaleString()} / {v.outputTokens.toLocaleString()}</td>
                  <td>{(v.avgLatencyMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 14 }}>
            {[...new Set(report.results.map((r) => r.scenarioId))].map((id) => {
              const name = report.results.find((r) => r.scenarioId === id)!.name;
              return (
                <details key={id} open={report.variants.some((v) => failed(v.label, id)?.passed === false)} style={{ marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13 }}>
                    <b>{name}</b>{" "}
                    {report.variants.map((v) => (
                      <span key={v.label} className={`pill ${failed(v.label, id)?.passed ? "pill-ok" : "pill-stop"}`} style={{ marginLeft: 4 }}>
                        {report.variants.length > 1 ? `${v.label.split(" · ")[0]}: ` : ""}{failed(v.label, id)?.passed ? "pass" : "fail"}
                      </span>
                    ))}
                  </summary>
                  {report.variants.map((v) => {
                    const r = failed(v.label, id);
                    if (!r) return null;
                    return (
                      <div key={v.label} style={{ margin: "6px 0 6px 12px", fontSize: 12.5 }}>
                        {report.variants.length > 1 && <div style={{ fontWeight: 600 }}>{v.label}</div>}
                        {r.error && <div style={{ color: "var(--stop)" }}>Run failed: {r.error}</div>}
                        {r.checks.length === 0 && !r.error && <div style={{ color: "var(--ink-faint)" }}>No expectations set — it only checks the run doesn&apos;t error.</div>}
                        {r.checks.map((c, i) => (
                          <div key={i}><span className={`pill ${c.passed ? "pill-ok" : "pill-stop"}`}>{c.passed ? "ok" : "failed"}</span> {c.name}{!c.passed && <span style={{ color: "var(--stop)" }}> — {c.detail}</span>}</div>
                        ))}
                      </div>
                    );
                  })}
                </details>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
