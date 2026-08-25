"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RequiredFieldType } from "@envoy/types";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../../../lib/errors";

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

const FIELD_TYPES: RequiredFieldType[] = ["text", "email", "phone", "number", "date", "boolean"];

export default function NewAgentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [fields, setFields] = useState<FieldRow[]>([
    {
      key: "email",
      label: "Email",
      type: "email",
      required: true,
      prompt: "The visitor's email address, so we can follow up.",
    },
  ]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const agent = await api.agents.create({
        name,
        script,
        requiredFields: fields
          .filter((f) => f.key && f.label)
          .map((f) => ({ ...f, prompt: f.prompt || undefined })),
        hardRules: rules.filter((r) => r.text).map((r) => ({ ...r, severity: "high" })),
      });
      router.push(`/dashboard/agents/${agent.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 className="page-title">New agent</h1>
      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={onSubmit}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="script">Script &amp; persona</label>
            <textarea
              id="script"
              rows={4}
              value={script}
              onInput={(e) => setScript((e.target as HTMLTextAreaElement).value)}
              placeholder='e.g. You help visitors book a demo of our product. Always address the visitor by their first name once you know it, and keep replies under 3 sentences.'
            />
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>
              General behavior and tone — persona, style, "always do X" habits. For things the
              agent must <em>never</em> say, use Hard rules below instead.
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
            goes in Script &amp; persona above). E.g. "Never promise guaranteed refunds."
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

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create agent"}
        </button>
      </form>
    </div>
  );
}
