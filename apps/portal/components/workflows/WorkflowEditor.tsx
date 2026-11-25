"use client";

import { useRef, useState } from "react";
import type { Agent, Form, WorkflowPreview } from "@envoy/sdk";
import { ConditionOp, OUTCOME_FIELD, OutcomeType, WorkflowDef, WAIT_UNITS, type WorkflowConditions, type WorkflowStep } from "@envoy/types";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { addStep, blankCondition, formatOffset, insertVariable, moveStep, parseSampleLead, removeStep, replaceStep, toggleStepCondition, variableKeys, type Draft } from "../../lib/workflow-editor";

const OPS = ConditionOp.options;
const ZONES = ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
const STEP_LABEL: Record<WorkflowStep["type"], string> = { send_email: "Send email", send_sms: "Send text message", wait: "Wait", exit: "End here" };

/** "field / test / value" rows. `label` prefixes every aria-label, e.g. "Condition" or "Step 2 condition". */
function ConditionsEditor({ value, onChange, label, emptyText }: { value: WorkflowConditions; onChange: (c: WorkflowConditions) => void; label: string; emptyText?: string }) {
  const rows = value.conditions;
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => onChange({ ...value, conditions: rows.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      {rows.length > 1 && (
        <select aria-label={label === "Condition" ? "Match" : `${label} match`} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as "all" | "any" })} style={{ marginBottom: 6 }}>
          <option value="all">meets ALL of these</option><option value="any">meets ANY of these</option>
        </select>
      )}
      {rows.length === 0 && emptyText && <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: "0 0 6px" }}>{emptyText}</p>}
      {rows.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          <input aria-label={`${label} ${i + 1} field`} list="wf-fields" value={c.field} onChange={(e) => setRow(i, { field: e.target.value })} placeholder="field" style={{ width: 150 }} />
          <select aria-label={`${label} ${i + 1} test`} value={c.op} onChange={(e) => setRow(i, { op: e.target.value as typeof c.op })}>
            {OPS.map((op) => <option key={op} value={op}>{op.replace(/_/g, " ")}</option>)}
          </select>
          {!["is_empty", "is_not_empty"].includes(c.op) && (
            <input aria-label={`${label} ${i + 1} value`} value={String(c.value ?? "")} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" style={{ width: 150 }} />
          )}
          <button type="button" className="btn" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange({ ...value, conditions: rows.filter((_, j) => j !== i) })} style={{ fontSize: 12 }}>✕</button>
        </div>
      ))}
      <button type="button" className="btn" aria-label={`Add ${label.toLowerCase()}`} onClick={() => onChange({ ...value, conditions: [...rows, blankCondition()] })} style={{ fontSize: 12.5 }}>+ Add condition</button>
    </>
  );
}

function issueText(draft: Draft): string | null {
  const parsed = WorkflowDef.safeParse(draft);
  if (parsed.success) return null;
  const i = parsed.error.issues[0]!;
  const path = i.path.map((p) => (typeof p === "number" ? `step ${p + 1}` : p)).filter((p) => p !== "steps").join(" › ");
  return path ? `${path}: ${i.message}` : i.message;
}

export function WorkflowEditor({
  initial,
  readOnly,
  agents,
  forms,
  onSave,
}: {
  initial: Draft;
  readOnly: boolean;
  agents: Agent[];
  forms: Form[];
  onSave(def: WorkflowDef): Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState("name = Ada\nemail = ada@example.com\nphone = +14155550100");
  const [outcome, setOutcome] = useState("");
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const focused = useRef<{ stepIndex: number; field: "subject" | "body" } | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (i: number, step: WorkflowStep) => set({ steps: replaceStep(draft.steps, i, step) });

  const source = draft.trigger.type === "conversation_completed" ? agents.find((a) => a.id === draft.trigger.agentId) : undefined;
  const sourceForm = draft.trigger.type === "form_submitted" ? forms.find((f) => f.id === draft.trigger.formId) : undefined;
  const collected = source ? source.requiredFields.map((f) => f.key) : sourceForm ? sourceForm.schema.steps.flatMap((s) => s.fields.map((f) => f.key)) : ["name", "email", "phone"];
  const keys = variableKeys(collected);

  function addVariable(key: string) {
    const f = focused.current;
    const step = f ? draft.steps[f.stepIndex] : undefined;
    if (!f || !step || step.type === "wait" || step.type === "exit") return;
    if (step.type === "send_sms" && f.field === "body") setStep(f.stepIndex, { ...step, body: insertVariable(step.body, key) });
    else if (step.type === "send_email") setStep(f.stepIndex, { ...step, [f.field]: insertVariable(step[f.field], key) });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const problem = issueText(draft);
    if (problem) return setError(problem);
    setError(null);
    setSaving(true);
    try {
      await onSave(WorkflowDef.parse(draft));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    const problem = issueText(draft);
    if (problem) return setError(problem);
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await api.workflows.preview(WorkflowDef.parse(draft), { data: parseSampleLead(sample), outcome: (outcome || null) as never }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  const lock = readOnly;
  const hasSms = draft.steps.some((s) => s.type === "send_sms");

  return (
    <form onSubmit={save}>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <fieldset disabled={lock} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="wf-name">Name</label>
            <input id="wf-name" value={draft.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Follow up hot leads" />
          </div>
          <strong style={{ fontSize: 13, display: "block", margin: "6px 0" }}>When</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Trigger" value={draft.trigger.type} onChange={(e) => set({ trigger: { type: e.target.value as Draft["trigger"]["type"] } })}>
              <option value="conversation_completed">a conversation with an agent finishes</option>
              <option value="form_submitted">a lead form is submitted</option>
            </select>
            {draft.trigger.type === "conversation_completed" ? (
              <select aria-label="Which agent" value={draft.trigger.agentId ?? ""} onChange={(e) => set({ trigger: { type: "conversation_completed", agentId: e.target.value || undefined } })}>
                <option value="">any agent</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : (
              <select aria-label="Which form" value={draft.trigger.formId ?? ""} onChange={(e) => set({ trigger: { type: "form_submitted", formId: e.target.value || undefined } })}>
                <option value="">any form</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}
          </div>

          <strong style={{ fontSize: 13, display: "block", margin: "14px 0 6px" }}>Only if the lead…</strong>
          <ConditionsEditor label="Condition" value={draft.conditions} onChange={(conditions) => set({ conditions })} emptyText="No conditions: every lead qualifies." />
          <datalist id="wf-fields">{[...collected, OUTCOME_FIELD].map((k) => <option key={k} value={k} />)}</datalist>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "6px 0 0" }}>Use <code>{OUTCOME_FIELD}</code> to test how the conversation ended ({OutcomeType.options.join(", ")}).</p>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Then, in order</strong>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
            Click a subject or message box, then a field below to insert it. Insert <code>{"{{name}}"}</code>-style fields to personalise.{" "}
            {keys.map((k) => <button key={k} type="button" className="pill pill-gray" onClick={() => addVariable(k)} style={{ border: 0, cursor: "pointer", marginRight: 4 }}>{`{{${k}}}`}</button>)}
          </p>
          {draft.steps.map((step, i) => (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>{i + 1}. {STEP_LABEL[step.type]}</b>
                <span style={{ display: "flex", gap: 4 }}>
                  <button type="button" className="btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => set({ steps: moveStep(draft.steps, i, -1) })} style={{ fontSize: 12 }}>↑</button>
                  <button type="button" className="btn" aria-label={`Move step ${i + 1} down`} disabled={i === draft.steps.length - 1} onClick={() => set({ steps: moveStep(draft.steps, i, 1) })} style={{ fontSize: 12 }}>↓</button>
                  <button type="button" className="btn" aria-label={`Remove step ${i + 1}`} disabled={draft.steps.length === 1} onClick={() => set({ steps: removeStep(draft.steps, i) })} style={{ fontSize: 12 }}>✕</button>
                </span>
              </div>
              {step.when && (
                <div style={{ background: "var(--panel-hover)", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, display: "block", marginBottom: 4 }}>{step.type === "exit" ? "End the sequence here if the lead…" : "Only do this if the lead…"}</span>
                  <ConditionsEditor label={`Step ${i + 1} condition`} value={step.when} onChange={(when) => setStep(i, when.conditions.length === 0 && step.type !== "exit" ? toggleStepCondition(step) : { ...step, when })} />
                  <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "6px 0 0" }}>Checked when this step is reached, using the lead&apos;s data at that time.</p>
                </div>
              )}
              {!step.when && <button type="button" className="btn" onClick={() => setStep(i, toggleStepCondition(step))} style={{ fontSize: 12, marginBottom: 8 }}>+ Only if…</button>}
              {step.type === "wait" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input aria-label={`Step ${i + 1} wait amount`} type="number" min={1} value={step.amount} onChange={(e) => setStep(i, { ...step, amount: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 80 }} />
                  <select aria-label={`Step ${i + 1} wait unit`} value={step.unit} onChange={(e) => setStep(i, { ...step, unit: e.target.value as typeof step.unit })}>{WAIT_UNITS.map((u) => <option key={u}>{u}</option>)}</select>
                </div>
              )}
              {step.type === "send_email" && (
                <>
                  <div className="field">
                    <label htmlFor={`to-${i}`}>To</label>
                    <select id={`to-${i}`} value={step.to === "lead" ? "lead" : "team"} onChange={(e) => setStep(i, { ...step, to: e.target.value === "lead" ? "lead" : "" })}>
                      <option value="lead">the lead</option><option value="team">my own team (a notification)</option>
                    </select>
                    {step.to !== "lead" && <input aria-label={`Step ${i + 1} team address`} type="email" value={step.to} onChange={(e) => setStep(i, { ...step, to: e.target.value })} placeholder="sales@yourcompany.com" style={{ marginTop: 6 }} />}
                  </div>
                  <div className="field"><label htmlFor={`subj-${i}`}>Subject</label>
                    <input id={`subj-${i}`} value={step.subject} maxLength={200} onFocus={() => (focused.current = { stepIndex: i, field: "subject" })} onChange={(e) => setStep(i, { ...step, subject: e.target.value })} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label htmlFor={`body-${i}`}>Message</label>
                    <textarea id={`body-${i}`} rows={4} value={step.body} maxLength={5000} onFocus={() => (focused.current = { stepIndex: i, field: "body" })} onChange={(e) => setStep(i, { ...step, body: e.target.value })} />
                    {step.to === "lead" && <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>A footer naming your business and an unsubscribe link is added automatically.</p>}</div>
                </>
              )}
              {step.type === "send_sms" && (
                <div className="field" style={{ marginBottom: 0 }}><label htmlFor={`sms-${i}`}>Message</label>
                  <textarea id={`sms-${i}`} rows={3} value={step.body} maxLength={480} onFocus={() => (focused.current = { stepIndex: i, field: "body" })} onChange={(e) => setStep(i, { ...step, body: e.target.value })} />
                  <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>“Reply STOP to opt out.” is added automatically. {step.body.length}/480</p></div>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["send_email", "send_sms", "wait", "exit"] as const).map((t) => <button key={t} type="button" className="btn" disabled={draft.steps.length >= 12} onClick={() => set({ steps: addStep(draft.steps, t) })} style={{ fontSize: 12.5 }}>+ {STEP_LABEL[t]}</button>)}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Sending rules</strong>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="field"><label htmlFor="s-email">Email is in field</label><input id="s-email" value={draft.settings.emailField} onChange={(e) => set({ settings: { ...draft.settings, emailField: e.target.value } })} style={{ width: 140 }} /></div>
            <div className="field"><label htmlFor="s-phone">Phone is in field</label><input id="s-phone" value={draft.settings.phoneField} onChange={(e) => set({ settings: { ...draft.settings, phoneField: e.target.value } })} style={{ width: 140 }} /></div>
          </div>
          {hasSms && (
            <>
              <div className="field"><label htmlFor="s-consent">Only text leads who ticked (field name)</label>
                <input id="s-consent" value={draft.settings.smsConsentField ?? ""} onChange={(e) => set({ settings: { ...draft.settings, smsConsentField: e.target.value || undefined } })} placeholder="e.g. sms_consent — leave blank to text everyone with a number" style={{ maxWidth: 420 }} />
                {!draft.settings.smsConsentField && <p style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 4 }}>Without a consent field, every lead with a valid number is texted. Many countries require explicit consent before marketing texts — make sure your form or agent collects it.</p>}</div>
              <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 8px" }}>Texts only go to numbers written internationally (+44…, +1…). Leads who reply STOP are never texted again.</p>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}><input type="checkbox" checked={draft.settings.quietHours.enabled} onChange={(e) => set({ settings: { ...draft.settings, quietHours: { ...draft.settings.quietHours, enabled: e.target.checked } } })} /> Hold texts during quiet hours</label>
                {draft.settings.quietHours.enabled && (
                  <>
                    <span style={{ fontSize: 12.5 }}>from <input aria-label="Quiet hours start" type="number" min={0} max={23} value={draft.settings.quietHours.startHour} onChange={(e) => set({ settings: { ...draft.settings, quietHours: { ...draft.settings.quietHours, startHour: Number(e.target.value) } } })} style={{ width: 60 }} />:00 to <input aria-label="Quiet hours end" type="number" min={0} max={23} value={draft.settings.quietHours.endHour} onChange={(e) => set({ settings: { ...draft.settings, quietHours: { ...draft.settings.quietHours, endHour: Number(e.target.value) } } })} style={{ width: 60 }} />:00</span>
                    <span style={{ fontSize: 12.5 }}>in <input aria-label="Time zone" list="wf-zones" value={draft.settings.timezone} onChange={(e) => set({ settings: { ...draft.settings, timezone: e.target.value } })} style={{ width: 170 }} /></span>
                  </>
                )}
              </div>
              <datalist id="wf-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
            </>
          )}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={draft.settings.exitOnReply} onChange={(e) => set({ settings: { ...draft.settings, exitOnReply: e.target.checked } })} /> Stop the sequence if the lead replies to a text
          </label>
        </div>
      </fieldset>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Preview with a sample lead</strong>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>See what each step would do and when. Nothing is sent.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <textarea aria-label="Sample lead" rows={4} value={sample} onChange={(e) => setSample(e.target.value)} style={{ flex: "1 1 260px", fontFamily: "monospace", fontSize: 12 }} />
          <div>
            <select aria-label="Sample outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">no outcome</option>{OutcomeType.options.map((o) => <option key={o}>{o}</option>)}</select>
            <div><button type="button" className="btn" onClick={runPreview} disabled={previewing} style={{ marginTop: 8 }}>{previewing ? "Checking…" : "Preview"}</button></div>
          </div>
        </div>
        {preview && (
          <div style={{ marginTop: 12, fontSize: 12.5 }} aria-label="Preview result">
            <p><span className={`pill ${preview.qualifies ? "pill-ok" : "pill-stop"}`}>{preview.qualifies ? "qualifies" : "does not qualify"}</span> {preview.qualifies ? "This lead would enter the workflow." : "This lead would not be enrolled."}</p>
            {preview.steps.map((s) => (
              <div key={s.index} style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
                <span className={`pill ${s.result === "send" ? "pill-ok" : s.result === "skip" ? "pill-warn" : "pill-gray"}`}>{s.result === "send" ? "will send" : s.result === "end" ? "ends" : s.result}</span>{" "}
                <b>{formatOffset(s.atMs)}</b> — {s.result === "end" || (s.type === "wait" && s.result === "wait") ? s.detail : s.result === "send" ? <>{STEP_LABEL[s.type]} to <code>{s.to}</code>{s.detail ? ` (${s.detail})` : ""}</> : `${STEP_LABEL[s.type]} skipped: ${s.detail}`}
                {s.result === "send" && <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontFamily: "inherit", background: "var(--panel-hover)", padding: 8, borderRadius: 6 }}>{s.subject ? `Subject: ${s.subject}\n\n` : ""}{s.body}</pre>}
                {s.missingVariables && s.missingVariables.length > 0 && <div style={{ color: "var(--warn)" }}>This lead has no value for {s.missingVariables.map((m) => `{{${m}}}`).join(", ")} — it would be left blank.</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {!lock && <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save workflow"}</button>}
    </form>
  );
}
