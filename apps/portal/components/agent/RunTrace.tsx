"use client";

import { useEffect, useState } from "react";
import type { RunStep } from "@envoy/sdk";
import { api } from "../../lib/api";

const KIND_PILL: Record<RunStep["kind"], string> = {
  model: "pill-gray",
  tool: "pill-ok",
  judge: "pill-warn",
  extract: "pill-gray",
  limit: "pill-stop",
};

function brief(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Step-by-step record of what the agent did on each visitor message. Renders nothing for classic conversations (they have no trace). */
export function RunTrace({ conversationId }: { conversationId: string }) {
  const [steps, setSteps] = useState<RunStep[] | null>(null);

  useEffect(() => {
    api.conversations.trace(conversationId).then(setSteps).catch(() => setSteps([]));
  }, [conversationId]);

  if (!steps || steps.length === 0) return null;
  const turns = [...new Set(steps.map((s) => s.turn))];

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Agent run trace</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
        What the agent did on each visitor message: model calls, tools it used, and rule checks.
      </p>
      {turns.map((turn) => (
        <details key={turn} open={turns.length <= 3} style={{ marginBottom: 6 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
            Message {turn} · {steps.filter((s) => s.turn === turn).length} steps
          </summary>
          <div style={{ marginTop: 6 }}>
            {steps
              .filter((s) => s.turn === turn)
              .map((s) => (
                <div key={s.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "4px 0", alignItems: "baseline" }}>
                  <span className={`pill ${s.error ? "pill-stop" : KIND_PILL[s.kind]}`} style={{ minWidth: 52, textAlign: "center" }}>{s.kind}</span>
                  <code style={{ fontWeight: 600 }}>{s.name}</code>
                  <span style={{ flex: 1, color: s.error ? "var(--stop)" : "var(--ink-faint)", wordBreak: "break-word" }}>
                    {s.error ?? (brief(s.input) && s.output ? `${brief(s.input)} → ${brief(s.output)}` : brief(s.output) || brief(s.input))}
                  </span>
                  {s.latencyMs !== null && <span style={{ color: "var(--ink-faint)" }}>{s.latencyMs}ms</span>}
                </div>
              ))}
          </div>
        </details>
      ))}
    </div>
  );
}
