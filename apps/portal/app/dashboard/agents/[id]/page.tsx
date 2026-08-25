"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent } from "@envoy/sdk";
import type { RequiredFieldType } from "@envoy/types";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../../../lib/errors";
import { useToast } from "../../../../components/Toast";

const WIDGET_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? "http://localhost:5173";
const FIELD_TYPES: RequiredFieldType[] = ["text", "email", "phone", "number", "date", "boolean"];

interface FieldRow {
  key: string;
  label: string;
  type: RequiredFieldType;
  required: boolean;
  prompt: string;
}

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

  useEffect(() => {
    api.agents
      .get(params.id)
      .then((a) => {
        setAgent(a);
        setName(a.name);
        setScript(a.script);
        setFields(
          a.requiredFields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            prompt: f.prompt ?? "",
          })),
        );
        setRules(a.hardRules.map((r) => ({ id: r.id, text: r.text, action: r.action })));
      })
      .catch((err) => setError(errorMessage(err)));
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

  function addField() {
    setFields((prev) => [...prev, { key: "", label: "", type: "text", required: true, prompt: "" }]);
  }
  function updateField(i: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeField(i: number) {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
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
          .map((f) => ({ ...f, prompt: f.prompt || undefined })),
        hardRules: rules.filter((r) => r.text).map((r) => ({ ...r, severity: "high" })),
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <strong style={{ fontSize: 13.5 }}>Required fields</strong>
            <button type="button" className="btn" onClick={addField} style={{ fontSize: 12.5 }}>
              + Add field
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
            What the agent must collect before finishing. The description is injected into the
            agent's instructions so it knows exactly what to ask for and why.
          </p>
          {fields.length === 0 && (
            <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>No required fields yet.</p>
          )}
          {fields.map((field, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  placeholder="key (e.g. email)"
                  value={field.key}
                  onInput={(e) => updateField(i, { key: (e.target as HTMLInputElement).value })}
                  style={{ flex: 1 }}
                />
                <input
                  placeholder="Label"
                  value={field.label}
                  onInput={(e) => updateField(i, { label: (e.target as HTMLInputElement).value })}
                  style={{ flex: 1 }}
                />
                <select
                  value={field.type}
                  onChange={(e) =>
                    updateField(i, { type: (e.target as HTMLSelectElement).value as RequiredFieldType })
                  }
                  style={{ width: 110 }}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={() => removeField(i)}
                  aria-label={`Remove field ${field.label || i + 1}`}
                  style={{ fontSize: 12 }}
                >
                  ✕
                </button>
              </div>
              <input
                placeholder="Description for the agent (e.g. the visitor's preferred appointment date, in their own words)"
                value={field.prompt}
                onInput={(e) => updateField(i, { prompt: (e.target as HTMLInputElement).value })}
              />
            </div>
          ))}
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

        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
