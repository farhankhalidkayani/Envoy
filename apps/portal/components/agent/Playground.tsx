"use client";

import { useRef, useState } from "react";
import type { Agent, SimulationTurn } from "@envoy/sdk";
import { ScenarioDef, expectationFromOutcome, type ScenarioOutcome } from "@envoy/types";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { parseSandbox } from "../../lib/scenario-form";
import { useToast } from "../Toast";

interface Message {
  role: "visitor" | "agent";
  text: string;
  steps?: SimulationTurn["steps"];
}

const STEP_PILL: Record<string, string> = { model: "pill-gray", tool: "pill-ok", judge: "pill-warn", extract: "pill-gray", limit: "pill-stop" };
const brief = (v: unknown) => (v === undefined || v === null ? "" : (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 140));

/**
 * Chat with the agent exactly as a visitor would meet it, and watch what it does. Nothing here is real:
 * no conversation is recorded, no lead is created, and tools run against the sandbox below.
 */
export function Playground({ agent, onSaved }: { agent: Agent; onSaved(): void }) {
  const { showToast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SimulationTurn | null>(null);
  const [contacts, setContacts] = useState("");
  const [busy, setBusy] = useState("");
  const [saveName, setSaveName] = useState("");
  const allSteps = useRef<SimulationTurn["steps"]>([]);
  const blocked = useRef(0);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setSending(true);
    setMessages((m) => [...m, { role: "visitor", text }]);
    try {
      const turn = await api.agents.simulate(agent.id, text, sessionId, parseSandbox(contacts, busy));
      setSessionId(turn.sessionId);
      setState(turn);
      allSteps.current = [...allSteps.current, ...turn.steps];
      blocked.current += turn.blockedViolations;
      setMessages((m) => [...m, { role: "agent", text: turn.reply, steps: turn.steps }]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function restart() {
    if (sessionId) void api.agents.resetSimulation(agent.id, sessionId).catch(() => {});
    setMessages([]); setSessionId(undefined); setState(null); setError(null); setSaveName("");
    allSteps.current = []; blocked.current = 0;
  }

  async function saveAsScenario() {
    if (!state) return;
    const visitor = messages.filter((m) => m.role === "visitor").map((m) => m.text);
    const outcome: ScenarioOutcome = {
      replies: messages.filter((m) => m.role === "agent").map((m) => m.text),
      turnsUsed: visitor.length,
      completed: state.isComplete,
      outcomeType: state.outcomeType,
      handoffReason: state.handoffReason,
      capturedData: state.capturedData,
      toolCalls: allSteps.current.filter((s) => s.kind === "tool").map((s) => ({ name: s.name, ok: !s.error })),
      goalProgress: Object.fromEntries(Object.entries(state.goalProgress).map(([k, v]) => [k, { status: v.status }])),
      blockedViolations: blocked.current,
    };
    const parsed = ScenarioDef.safeParse({
      name: saveName.trim() || "Saved from playground",
      turns: visitor,
      expect: expectationFromOutcome(outcome),
      sandbox: parseSandbox(contacts, busy),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    try {
      await api.agents.scenarios.create(agent.id, parsed.data);
      showToast("Saved as a scenario — it now guards this behavior.");
      setSaveName("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(240px,1fr)", gap: 16 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 460 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong style={{ fontSize: 13.5 }}>Playground</strong>
          <button type="button" className="btn" onClick={restart} style={{ fontSize: 12 }}>New conversation</button>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
          Talk to <b>{agent.name}</b> (v{agent.version}) as a visitor would. Nothing here is recorded as a real conversation or lead, and
          tools run against the sandbox on the right — no real bookings or CRM lookups.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <div style={{ flex: 1, overflowY: "auto", marginBottom: 10 }} aria-live="polite">
          {messages.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>Say something to start.</p>}
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 10, textAlign: m.role === "visitor" ? "right" : "left" }}>
              <div style={{ display: "inline-block", maxWidth: "85%", padding: "8px 12px", borderRadius: 10, fontSize: 13, textAlign: "left",
                background: m.role === "visitor" ? "var(--accent)" : "var(--panel-hover)", color: m.role === "visitor" ? "#fff" : "var(--ink)" }}>
                {m.text}
              </div>
              {m.steps && m.steps.length > 0 && (
                <details style={{ fontSize: 11.5, marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", color: "var(--ink-faint)" }}>What the agent did ({m.steps.length} steps)</summary>
                  {m.steps.map((s) => (
                    <div key={s.seq} style={{ display: "flex", gap: 6, padding: "2px 0", alignItems: "baseline" }}>
                      <span className={`pill ${s.error ? "pill-stop" : STEP_PILL[s.kind] ?? "pill-gray"}`}>{s.kind}</span>
                      <code>{s.name}</code>
                      <span style={{ color: s.error ? "var(--stop)" : "var(--ink-faint)", wordBreak: "break-word" }}>{s.error ?? (brief(s.input) && brief(s.output) ? `${brief(s.input)} → ${brief(s.output)}` : brief(s.output) || brief(s.input))}</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          ))}
          {sending && <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>Thinking…</p>}
        </div>
        <form onSubmit={send} style={{ display: "flex", gap: 8 }}>
          <input aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type as the visitor…" style={{ flex: 1 }} disabled={sending || state?.isComplete} />
          <button className="btn btn-primary" disabled={sending || !input.trim() || state?.isComplete}>Send</button>
        </form>
        {state?.isComplete && (
          <p style={{ fontSize: 12.5, marginTop: 8, color: "var(--ink-faint)" }}>
            Conversation ended{state.handoffReason ? ` (handed to a human: ${state.handoffReason})` : state.outcomeType ? ` — ${state.outcomeType}` : ""}. Start a new one to keep testing.
          </p>
        )}
      </div>

      <div>
        <div className="card" style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Captured so far</strong>
          {state && Object.keys(state.capturedData).length > 0 ? (
            <table><tbody>{Object.entries(state.capturedData).map(([k, v]) => <tr key={k}><td style={{ fontWeight: 600 }}>{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
          ) : <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Nothing yet.</p>}
          {state && Object.keys(state.goalProgress).length > 0 && (
            <div style={{ marginTop: 8 }}>
              {Object.entries(state.goalProgress).map(([id, p]) => (
                <div key={id} style={{ fontSize: 12.5 }}><span className={`pill ${p.status === "achieved" ? "pill-ok" : p.status === "failed" ? "pill-stop" : "pill-gray"}`}>{p.status.replace("_", " ")}</span> <code>{id}</code></div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Sandbox</strong>
          <div className="field">
            <label htmlFor="sb-contacts">Contacts in the pretend CRM</label>
            <textarea id="sb-contacts" rows={2} value={contacts} onChange={(e) => setContacts(e.target.value)} placeholder="ada@example.com, Ada" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="sb-busy">Busy times in the pretend calendar</label>
            <textarea id="sb-busy" rows={2} value={busy} onChange={(e) => setBusy(e.target.value)} placeholder="2030-01-01T10:00:00Z, 2030-01-01T11:00:00Z" />
          </div>
        </div>

        {state && messages.length > 0 && (
          <div className="card">
            <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Keep this behavior</strong>
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8 }}>
              Save this conversation as a scenario. Its visitor messages are replayed, and what just happened becomes what must keep happening.
            </p>
            <input aria-label="Scenario name" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Scenario name" style={{ width: "100%", marginBottom: 8 }} />
            <button type="button" className="btn" onClick={saveAsScenario}>Save as scenario</button>
          </div>
        )}
      </div>
    </div>
  );
}
