"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent } from "@envoy/sdk";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../../../lib/errors";
import { useToast } from "../../../../components/Toast";

const WIDGET_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? "http://localhost:5173";

export default function AgentDetailPage() {
  const { showToast } = useToast();
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    api.agents.get(params.id).then(setAgent).catch((err) => setError(errorMessage(err)));
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

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Required fields</strong>
        {agent.requiredFields.length === 0 ? (
          <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>None configured.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {agent.requiredFields.map((f) => (
              <li key={f.key} style={{ marginBottom: 4 }}>
                {f.label} <span style={{ color: "var(--ink-faint)" }}>({f.type})</span>
                {f.prompt && (
                  <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>{f.prompt}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Hard rules</strong>
        {agent.hardRules.length === 0 ? (
          <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>None configured.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {agent.hardRules.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
