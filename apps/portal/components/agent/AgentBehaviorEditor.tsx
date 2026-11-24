"use client";

import type { AgentSpec, BuiltInToolName, GoalDef } from "@envoy/types";
import { CORE_TOOL_NAMES, OPT_IN_TOOL_NAMES } from "@envoy/types";

const TOOL_INFO: Record<BuiltInToolName, { label: string; help: string }> = {
  capture_field: { label: "Capture field", help: "Records each required field as the visitor provides it, with validation." },
  update_goal: { label: "Update goal", help: "Lets the agent report progress on the goals above. Only used when you define goals." },
  end_conversation: { label: "End conversation", help: "Finishes the conversation — only allowed once required fields are captured and primary goals are resolved." },
  handoff_to_human: { label: "Hand off to a human", help: "Passes the visitor to your team when they ask for a person or the agent can't help." },
  lookup_crm_contact: { label: "Look up CRM contact", help: "Checks whether the visitor is already in your CRM (by the email they gave) so it can greet returning customers. Shares only their first name. Needs the CRM connected." },
  check_calendar_availability: { label: "Check calendar availability", help: "Reads which times are busy on your calendar so it can offer real slots. Shows times only, never event details. Needs the calendar connected." },
  book_meeting: { label: "Book a meeting", help: "Books a slot on your calendar once the visitor agrees, after re-checking it's free. Only invites the email the visitor gave. Needs the calendar connected." },
};
const TOOL_ORDER: BuiltInToolName[] = [
  "capture_field", "update_goal", "end_conversation", "handoff_to_human",
  "lookup_crm_contact", "check_calendar_availability", "book_meeting",
];

function goalIdFrom(title: string, taken: Set<string>): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let base = words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("") || "goal";
  if (!/^[a-z]/.test(base)) base = `goal${base}`;
  base = base.slice(0, 32);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  return id;
}

export function AgentBehaviorEditor({ spec, onChange }: { spec: AgentSpec; onChange(spec: AgentSpec): void }) {
  const agentic = spec.runtime.mode === "agentic";
  const set = (patch: Partial<AgentSpec>) => onChange({ ...spec, ...patch });
  const setRuntime = (patch: Partial<AgentSpec["runtime"]>) => set({ runtime: { ...spec.runtime, ...patch } });

  function updateGoal(i: number, patch: Partial<GoalDef>) {
    set({ goals: spec.goals.map((g, idx) => (idx === i ? { ...g, ...patch } : g)) });
  }
  function addGoal() {
    const taken = new Set(spec.goals.map((g) => g.id));
    set({ goals: [...spec.goals, { id: goalIdFrom("New goal", taken), title: "", successCriteria: "", priority: "primary" }] });
  }
  /** Id derives from the title only until the goal has been saved once — afterwards it is a stable reference in traces. */
  function renameGoal(i: number, title: string) {
    const goal = spec.goals[i]!;
    const taken = new Set(spec.goals.filter((_, idx) => idx !== i).map((g) => g.id));
    const autoId = /^(newGoal|goal)\d*$/.test(goal.id) || goal.id === goalIdFrom(goal.title, taken);
    updateGoal(i, { title, ...(autoId && title.trim() ? { id: goalIdFrom(title, taken) } : {}) });
  }

  const permission = (name: BuiltInToolName) => spec.tools.find((t) => t.name === name);
  function setTool(name: BuiltInToolName, patch: { enabled?: boolean; maxCallsPerConversation?: number | undefined }) {
    const current = permission(name) ?? { name, enabled: !OPT_IN_TOOL_NAMES.includes(name) };
    const next = { ...current, ...patch };
    const rest = spec.tools.filter((t) => t.name !== name);
    // A tool's default is "on" for regular tools and "off" for opt-in ones; only non-default choices are stored.
    const defaultEnabled = !OPT_IN_TOOL_NAMES.includes(name);
    const isDefault = next.enabled === defaultEnabled && next.maxCallsPerConversation === undefined;
    set({ tools: isDefault ? rest : [...rest, next] });
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Agent behavior</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
        Choose how the agent works. <b>Classic</b> replies once per message. <b>Agentic</b> can plan,
        call tools, and pursue goals across several steps per message — every action is validated and
        logged, and your hard rules still apply to every reply.
      </p>

      <div className="field">
        <label htmlFor="runtime-mode">Mode</label>
        <select
          id="runtime-mode"
          value={spec.runtime.mode}
          onChange={(e) => setRuntime({ mode: e.target.value as AgentSpec["runtime"]["mode"] })}
        >
          <option value="classic">Classic (single reply)</option>
          <option value="agentic">Agentic (tools &amp; goals)</option>
        </select>
      </div>

      {agentic && (
        <>
          <div className="field">
            <label htmlFor="persona">Persona &amp; tone</label>
            <textarea
              id="persona"
              rows={2}
              value={spec.persona}
              maxLength={2000}
              onChange={(e) => set({ persona: e.target.value })}
              placeholder="e.g. Warm, brief, no emojis. Speaks like a helpful concierge."
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <strong style={{ fontSize: 13 }}>Goals</strong>
              <button type="button" className="btn" onClick={addGoal} style={{ fontSize: 12.5 }} disabled={spec.goals.length >= 10}>
                + Add goal
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
              What the agent is trying to achieve. A conversation can only end once its primary goals are achieved or marked failed.
            </p>
            {spec.goals.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>No goals — the agent just collects the required fields.</p>}
            {spec.goals.map((g, i) => (
              <div key={g.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <input
                    aria-label={`Goal ${i + 1} title`}
                    placeholder="Goal, e.g. Book a demo"
                    value={g.title}
                    maxLength={120}
                    onChange={(e) => renameGoal(i, e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <select
                    aria-label={`Goal ${i + 1} priority`}
                    value={g.priority}
                    onChange={(e) => updateGoal(i, { priority: e.target.value as GoalDef["priority"] })}
                    style={{ width: 110 }}
                  >
                    <option value="primary">primary</option>
                    <option value="secondary">secondary</option>
                  </select>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Remove goal ${i + 1}`}
                    onClick={() => set({ goals: spec.goals.filter((_, idx) => idx !== i) })}
                    style={{ fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>
                <input
                  aria-label={`Goal ${i + 1} success criteria`}
                  placeholder="Success means… e.g. Visitor gave an email and picked a time"
                  value={g.successCriteria}
                  maxLength={500}
                  onChange={(e) => updateGoal(i, { successCriteria: e.target.value })}
                  style={{ width: "100%" }}
                />
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong style={{ fontSize: 13, display: "block", marginBottom: 4 }}>Tools</strong>
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
              What the agent is allowed to do. Core tools can't be turned off.
            </p>
            {TOOL_ORDER.map((name) => {
              const core = CORE_TOOL_NAMES.includes(name);
              const perm = permission(name);
              const optIn = OPT_IN_TOOL_NAMES.includes(name);
              const enabled = perm?.enabled ?? !optIn;
              return (
                <div key={name} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    id={`tool-${name}`}
                    checked={enabled}
                    disabled={core}
                    onChange={(e) => setTool(name, { enabled: e.target.checked })}
                    style={{ marginTop: 3 }}
                  />
                  <label htmlFor={`tool-${name}`} style={{ flex: 1, fontSize: 13 }}>
                    <b>{TOOL_INFO[name].label}</b>
                    {core && <span className="pill pill-gray" style={{ marginLeft: 6 }}>core</span>}
                    {optIn && <span className="pill pill-warn" style={{ marginLeft: 6 }}>off by default</span>}
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>{TOOL_INFO[name].help}</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    aria-label={`${TOOL_INFO[name].label} max calls per conversation`}
                    placeholder="max calls"
                    disabled={!enabled}
                    value={perm?.maxCallsPerConversation ?? ""}
                    onChange={(e) => setTool(name, { maxCallsPerConversation: e.target.value ? Number(e.target.value) : undefined })}
                    style={{ width: 92 }}
                  />
                </div>
              );
            })}
          </div>

          <div>
            <strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>Limits</strong>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="max-steps">Max steps per message</label>
                <input id="max-steps" type="number" min={1} max={12} value={spec.runtime.maxSteps}
                  onChange={(e) => setRuntime({ maxSteps: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: 90 }} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="max-tools">Max tool calls per message</label>
                <input id="max-tools" type="number" min={1} max={30} value={spec.runtime.maxToolCallsPerTurn}
                  onChange={(e) => setRuntime({ maxToolCallsPerTurn: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: 90 }} />
              </div>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 12.5 }}>
              <input type="checkbox" checked={spec.runtime.extractionFallback} onChange={(e) => setRuntime({ extractionFallback: e.target.checked })} style={{ marginTop: 2 }} />
              <span>
                <b>Safety-net extraction</b> — also scan each visitor message for field values, so details are still captured if the model forgets to record them. Costs one extra model call per message.
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}
