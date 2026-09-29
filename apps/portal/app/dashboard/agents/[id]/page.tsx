"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent } from "@envoy/sdk";
import type { WidgetConfig } from "@envoy/types";
import type { Form } from "@envoy/sdk";
import { WidgetSettings } from "../../../../components/widget/WidgetSettings";
import { RequiredFieldsBuilder } from "../../../../components/agent/RequiredFieldsBuilder";
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
  const [leadFormId, setLeadFormId] = useState<string | null>(null);
  const [forms, setForms] = useState<Form[]>([]);

  useEffect(() => {
    // Guards against React StrictMode's double-invoke (and any real remount):
    // without this, a second in-flight fetch resolving after the user has
    // already started editing would silently overwrite their in-progress
    // changes with the original server data.
    let cancelled = false;
    api.agents
      .get(params.id)
      .then((a) => {
        if (cancelled) return;
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
        setLeadFormId(a.leadFormId);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    // Forms failing to load shouldn't block the rest of the page — the
    // lead-form selector just falls back to "no forms available" (empty list).
    api.forms
      .list()
      .then((f) => {
        if (!cancelled) setForms(f);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function toggleLive() {
    if (!agent) return;
    setPublishing(true);
    try {
      const nextStatus = agent.status === "live" ? "paused" : "live";
      const updated = await api.agents.update(agent.id, { status: nextStatus });
      setAgent(updated);
      showToast(nextStatus === "live" ? "Agent published." : "Agent paused.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPublishing(false);
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
        <button
          onClick={toggleLive}
          disabled={publishing}
          className={`btn ${agent.status === "live" ? "" : "btn-primary"}`}
        >
          {agent.status === "live" ? "Pause" : "Publish"}
        </button>
      </div>

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
    </div>
  );
}
