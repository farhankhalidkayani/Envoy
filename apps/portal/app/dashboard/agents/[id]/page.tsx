"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent } from "@envoy/sdk";
import type { AgentSpec, WidgetConfig } from "@envoy/types";
import type { Form, ModelCredential, ScenarioRunReport, ScenarioStatus } from "@envoy/sdk";
import { WidgetSettings } from "../../../../components/widget/WidgetSettings";
import { RequiredFieldsBuilder } from "../../../../components/agent/RequiredFieldsBuilder";
import { AgentBehaviorEditor } from "../../../../components/agent/AgentBehaviorEditor";
import { ModelBadge } from "../../../../components/models/ModelBadge";
import { VersionHistory } from "../../../../components/agent/VersionHistory";
import { newId } from "@envoy/builder";
import type { FieldRow } from "../../../../lib/agent-fields";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../../../lib/errors";
import { useToast } from "../../../../components/Toast";

const WIDGET_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? "http://localhost:5173";

interface RuleRow {
  id: string;
  text: string;
  action: "block" | "escalate";
}

export default function AgentDetailPage() {
  const { showToast } = useToast();
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [widgetConfig, setWidgetConfig] = useState<WidgetConfig | null>(null);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [leadFormId, setLeadFormId] = useState<string | null>(null);
  const [forms, setForms] = useState<Form[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  // Before publishing, make sure the saved scenarios pass on this version (see toggleLive).
  const [gate, setGate] = useState<{ status: ScenarioStatus; report?: ScenarioRunReport } | null>(null);
  const [gateRunning, setGateRunning] = useState(false);

  // Persists across React StrictMode's dev-only double-invoke of this effect
  // (mount → cleanup → mount) — a ref, unlike a local `cancelled` flag, is
  // shared by both invocations, so this guarantees exactly one fetch and one
  // application of its result no matter how many times the effect body
  // itself runs. Without it, a second fetch's result can land after the
  // user has already started editing and silently overwrite their changes.
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (fetchedRef.current === params.id) return;
    fetchedRef.current = params.id;

    api.agents
      .get(params.id)
      .then((a) => {
        setAgent(a);
        setName(a.name);
        setScript(a.script);
        setFields(
          a.requiredFields.map((f) => ({
            id: newId("fld"),
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            prompt: f.prompt ?? "",
            options: f.options ?? [],
          })),
        );
        setRules(a.hardRules.map((r) => ({ id: r.id, text: r.text, action: r.action })));
        setWidgetConfig(a.widgetConfig);
        setSpec(a.spec);
        setLeadFormId(a.leadFormId);
      })
      .catch((err) => setError(errorMessage(err)));
    // Forms failing to load shouldn't block the rest of the page — the
    // lead-form selector just falls back to "no forms available" (empty list).
    api.forms.list().then(setForms).catch(() => {});
    api.models.listCredentials().then((c) => setCredentials(c.filter((k) => k.status === "active"))).catch(() => {});
  }, [params.id]);

  async function setStatus(nextStatus: "live" | "paused") {
    if (!agent) return;
    setPublishing(true);
    try {
      const updated = await api.agents.update(agent.id, { status: nextStatus });
      setAgent(updated);
      setGate(null);
      showToast(nextStatus === "live" ? "Agent published." : "Agent paused.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  }

  async function toggleLive() {
    if (!agent) return;
    if (agent.status === "live") return setStatus("paused");
    // Publishing is where a regression reaches real visitors: if this agent has scenarios that haven't passed on
    // its current version, say so first. (Skipped silently if the check itself fails — it never blocks publishing.)
    try {
      const status = await api.agents.scenarios.status(agent.id);
      if (status.total > 0 && (status.failing > 0 || status.notRun > 0)) return setGate({ status });
    } catch {
      /* fall through to publish */
    }
    return setStatus("live");
  }

  async function runGate() {
    if (!agent) return;
    setGateRunning(true);
    setError(null);
    try {
      const report = await api.agents.scenarios.run(agent.id);
      const status = await api.agents.scenarios.status(agent.id);
      if (report.results.every((r) => r.passed)) return setStatus("live");
      setGate({ status, report });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGateRunning(false);
    }
  }

  function addRule() {
    setRules((prev) => [...prev, { id: `rule_${prev.length + 1}`, text: "", action: "block" }]);
  }
  function updateRule(i: number, patch: Partial<RuleRow>) {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveChanges(e: React.FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.agents.update(agent.id, {
        name,
        script,
        requiredFields: fields
          .filter((f) => f.key && f.label)
          .map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            prompt: f.prompt || undefined,
            options: f.type === "select" ? f.options.filter(Boolean) : undefined,
          })),
        hardRules: rules.filter((r) => r.text).map((r) => ({ ...r, severity: "high" })),
        widgetConfig: widgetConfig ?? undefined,
        spec: spec ?? undefined,
        leadFormId,
      });
      setAgent(updated);
      showToast("Changes saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (error && !agent) {
    return (
      <div>
        <div className="error-banner">{error}</div>
        <Link href="/dashboard" className="btn">
          ← Back to agents
        </Link>
      </div>
    );
  }
  if (!agent) return <div className="card">Loading agent…</div>;

  const snippet = `<script src="${WIDGET_ORIGIN}/loader.js" data-agent="${agent.publicToken}"><\/script>`;

  return (
    <div style={{ maxWidth: 640 }}>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 className="page-title page-title--flush">{agent.name}</h1>
        <span style={{ display: "flex", gap: 8 }}>
        <Link href={`/dashboard/agents/${agent.id}/test`} className="btn">Test agent</Link>
        <Link href={`/dashboard/agents/${agent.id}/improve`} className="btn">Improve</Link>
        <button
          onClick={toggleLive}
          disabled={publishing}
          className={`btn ${agent.status === "live" ? "" : "btn-primary"}`}
        >
          {agent.status === "live" ? "Pause" : "Publish"}
        </button>
        </span>
      </div>

      {gate && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--warn)" }} role="alert">
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>
            {gate.report ? "Some scenarios failed on this version" : "Your scenarios haven't passed on this version yet"}
          </strong>
          <p style={{ fontSize: 12.5, marginBottom: 8 }}>
            v{gate.status.agentVersion}: {gate.status.passing} passing, {gate.status.failing} failing, {gate.status.notRun} not run.
            {gate.report && " Failing:"}
          </p>
          {gate.report?.results.filter((r) => !r.passed).map((r) => (
            <div key={r.runId} style={{ fontSize: 12.5, marginBottom: 4 }}>
              <b>{r.name}</b>
              {r.error ? <span style={{ color: "var(--stop)" }}> — {r.error}</span> : r.checks.filter((c) => !c.passed).map((c, i) => <div key={i} style={{ color: "var(--stop)", marginLeft: 12 }}>{c.name} — {c.detail}</div>)}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" disabled={gateRunning || publishing} onClick={runGate}>{gateRunning ? "Running scenarios…" : "Run scenarios, then publish"}</button>
            <button type="button" className="btn" disabled={publishing} onClick={() => setStatus("live")}>Publish anyway</button>
            <button type="button" className="btn" onClick={() => setGate(null)}>Cancel</button>
            <Link href={`/dashboard/agents/${agent.id}/test`} className="btn">Open scenarios</Link>
          </div>
        </div>
      )}

      <ModelBadge agentic={spec?.runtime.mode === "agentic"} override={Object.keys(spec?.models ?? {}).some((k) => k !== "allowPlatformFallback")} />

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Embed snippet</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 10 }}>
          Paste this on any page of your site. Config changes here go live immediately — no
          redeploy needed.
        </p>
        <code
          style={{
            display: "block",
            background: "var(--paper)",
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            wordBreak: "break-all",
          }}
        >
          {snippet}
        </code>
      </div>

      <form onSubmit={saveChanges}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              required
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="script">Script &amp; persona</label>
            <textarea
              id="script"
              rows={4}
              value={script}
              onInput={(e) => setScript((e.target as HTMLTextAreaElement).value)}
              placeholder='e.g. You help visitors book a demo of our product. Always address the visitor by their first name once you know it.'
            />
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>
              General behavior and tone. For things the agent must <em>never</em> say, use Hard
              rules below instead.
            </p>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Required fields</strong>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
            What the agent must collect before finishing. The description is injected into the
            agent's instructions so it knows exactly what to ask for and why. Drag to reorder.
          </p>
          <RequiredFieldsBuilder fields={fields} onChange={setFields} />
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <strong style={{ fontSize: 13.5 }}>Hard rules</strong>
            <button type="button" className="btn" onClick={addRule} style={{ fontSize: 12.5 }}>
              + Add rule
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
            Non-negotiable constraints, checked after every reply — not general behavior (that
            goes in Script &amp; persona above).
          </p>
          {rules.length === 0 && (
            <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>No hard rules yet.</p>
          )}
          {rules.map((rule, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <input
                placeholder="Rule text"
                value={rule.text}
                onInput={(e) => updateRule(i, { text: (e.target as HTMLInputElement).value })}
                style={{ flex: 1 }}
              />
              <select
                value={rule.action}
                onChange={(e) => updateRule(i, { action: (e.target as HTMLSelectElement).value as RuleRow["action"] })}
                style={{ width: 110 }}
              >
                <option value="block">block</option>
                <option value="escalate">escalate</option>
              </select>
              <button
                type="button"
                className="btn"
                onClick={() => removeRule(i)}
                aria-label={`Remove rule ${i + 1}`}
                style={{ fontSize: 12 }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {spec && <AgentBehaviorEditor spec={spec} onChange={setSpec} credentials={credentials} />}

        {widgetConfig && (
          <WidgetSettings
            config={widgetConfig}
            onChange={(update) => setWidgetConfig((c) => (c ? update(c) : c))}
            leadFormId={leadFormId}
            onLeadFormChange={setLeadFormId}
            forms={forms}
          />
        )}

        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>

      <div style={{ marginTop: 24 }}>
        <VersionHistory
          agent={agent}
          onRestored={(restored) => {
            setAgent(restored);
            setSpec(restored.spec);
            setScript(restored.script);
            setWidgetConfig(restored.widgetConfig);
            setFields(
              restored.requiredFields.map((f) => ({
                id: newId("fld"), key: f.key, label: f.label, type: f.type, required: f.required,
                prompt: f.prompt ?? "", options: f.options ?? [],
              })),
            );
            setRules(restored.hardRules.map((r) => ({ id: r.id, text: r.text, action: r.action })));
            showToast(`Restored — now on v${restored.version}.`);
          }}
        />
      </div>
    </div>
  );
}
