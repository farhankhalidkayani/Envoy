"use client";

import { useState } from "react";
import { BUILT_IN_TOOL_NAMES, OutcomeType, type AgentSpec, type ScenarioDef } from "@envoy/types";
import { defToForm, emptyScenarioForm, formToDef, type ScenarioForm, type ToolRule } from "../../lib/scenario-form";

const TRI = [["", "Don't check"], ["yes", "Yes"], ["no", "No"]] as const;

export function ScenarioEditor({
  initial,
  goals,
  onSave,
  onCancel,
}: {
  initial?: ScenarioDef;
  goals: AgentSpec["goals"];
  onSave(def: ScenarioDef): Promise<void>;
  onCancel(): void;
}) {
  const [form, setForm] = useState<ScenarioForm>(initial ? defToForm(initial) : emptyScenarioForm());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ScenarioForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = formToDef(form);
    if (!result.ok) return setError(result.error);
    setError(null);
    setSaving(true);
    try {
      await onSave(result.def);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ marginBottom: 16 }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>{initial ? "Edit scenario" : "New scenario"}</strong>
      {error && <div className="error-banner">{error}</div>}

      <div className="field">
        <label htmlFor="sc-name">Name</label>
        <input id="sc-name" required value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Visitor books a demo" />
      </div>
      <div className="field">
        <label htmlFor="sc-turns">What the visitor says</label>
        <textarea id="sc-turns" rows={4} required value={form.turns} onChange={(e) => set({ turns: e.target.value })} placeholder={"One message per line, in order:\nHi, I'd like a demo\nada@example.com"} />
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>Each is sent after the agent has replied to the one before. The run stops early if the conversation ends.</p>
      </div>

      <strong style={{ fontSize: 13, display: "block", margin: "14px 0 8px" }}>What must be true afterwards</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>Leave anything you don&apos;t care about on “Don&apos;t check”.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field"><label htmlFor="sc-completes">Conversation completes</label>
          <select id="sc-completes" value={form.completes} onChange={(e) => set({ completes: e.target.value as ScenarioForm["completes"] })}>{TRI.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="sc-outcome">Outcome</label>
          <select id="sc-outcome" value={form.outcomeType} onChange={(e) => set({ outcomeType: e.target.value as ScenarioForm["outcomeType"] })}><option value="">Don&apos;t check</option>{OutcomeType.options.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
        <div className="field"><label htmlFor="sc-handoff">Hands off to a human</label>
          <select id="sc-handoff" value={form.handoff} onChange={(e) => set({ handoff: e.target.value as ScenarioForm["handoff"] })}>{TRI.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="sc-maxturns">Finishes within (messages)</label>
          <input id="sc-maxturns" type="number" min={1} max={30} value={form.maxTurns} onChange={(e) => set({ maxTurns: e.target.value })} style={{ width: 90 }} /></div>
      </div>

      <div className="field"><label htmlFor="sc-keys">Fields that must be captured</label>
        <input id="sc-keys" value={form.capturedKeys} onChange={(e) => set({ capturedKeys: e.target.value })} placeholder="email, plan" /></div>
      <div className="field"><label htmlFor="sc-eq">Fields that must have a value</label>
        <textarea id="sc-eq" rows={2} value={form.capturedEquals} onChange={(e) => set({ capturedEquals: e.target.value })} placeholder="plan = pro" /></div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "1 1 220px" }}><label htmlFor="sc-has">A reply must mention</label>
          <textarea id="sc-has" rows={2} value={form.replyContains} onChange={(e) => set({ replyContains: e.target.value })} placeholder="one phrase per line" /></div>
        <div className="field" style={{ flex: "1 1 220px" }}><label htmlFor="sc-not">No reply may mention</label>
          <textarea id="sc-not" rows={2} value={form.replyNotContains} onChange={(e) => set({ replyNotContains: e.target.value })} placeholder="e.g. guaranteed refund" /></div>
      </div>

      <div className="field">
        <label>Tools</label>
        {BUILT_IN_TOOL_NAMES.map((tool) => (
          <div key={tool} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, fontSize: 12.5 }}>
            <code style={{ width: 200 }}>{tool}</code>
            <select aria-label={`${tool} rule`} value={form.toolRules[tool] ?? "any"} onChange={(e) => set({ toolRules: { ...form.toolRules, [tool]: e.target.value as ToolRule } })} style={{ width: 160 }}>
              <option value="any">Don&apos;t check</option><option value="must">Must be used</option><option value="never">Must not be used</option>
            </select>
          </div>
        ))}
      </div>

      {goals.length > 0 && (
        <div className="field">
          <label>Goals that must be achieved</label>
          {goals.map((g) => (
            <label key={g.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 4 }}>
              <input type="checkbox" checked={form.goalsAchieved.includes(g.id)} onChange={(e) => set({ goalsAchieved: e.target.checked ? [...form.goalsAchieved, g.id] : form.goalsAchieved.filter((x) => x !== g.id) })} />
              {g.title || g.id}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field"><label htmlFor="sc-minb">Replies blocked by rules — at least</label>
          <input id="sc-minb" type="number" min={0} value={form.minBlocked} onChange={(e) => set({ minBlocked: e.target.value })} style={{ width: 90 }} /></div>
        <div className="field"><label htmlFor="sc-maxb">— at most</label>
          <input id="sc-maxb" type="number" min={0} value={form.maxBlocked} onChange={(e) => set({ maxBlocked: e.target.value })} style={{ width: 90 }} /></div>
      </div>

      <details style={{ marginBottom: 14 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Sandbox (pretend CRM and calendar)</summary>
        <div className="field" style={{ marginTop: 8 }}><label htmlFor="sc-contacts">Contacts that exist</label>
          <textarea id="sc-contacts" rows={2} value={form.knownContacts} onChange={(e) => set({ knownContacts: e.target.value })} placeholder="ada@example.com, Ada" /></div>
        <div className="field"><label htmlFor="sc-busy">Busy calendar times</label>
          <textarea id="sc-busy" rows={2} value={form.busy} onChange={(e) => set({ busy: e.target.value })} placeholder="2030-01-01T10:00:00Z, 2030-01-01T11:00:00Z" /></div>
      </details>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save scenario"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
