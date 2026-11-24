"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Agent } from "@envoy/sdk";
import { api } from "../../../../../lib/api";
import { errorMessage } from "../../../../../lib/errors";
import { Playground } from "../../../../../components/agent/Playground";
import { ScenarioManager } from "../../../../../components/agent/ScenarioManager";

export default function AgentTestPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"playground" | "scenarios">("playground");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.agents.get(params.id).then(setAgent).catch((err) => setError(errorMessage(err)));
  }, [params.id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!agent) return <div className="card">Loading…</div>;

  return (
    <div style={{ maxWidth: 1000 }}>
      <Link href={`/dashboard/agents/${agent.id}`} style={{ fontSize: 12.5 }}>← Back to {agent.name}</Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>Test {agent.name}</h1>
      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 14 }}>
        Tests use the saved version (v{agent.version}) of this agent. Save your changes first to test them. It doesn&apos;t need to be published.
      </p>
      <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["playground", "scenarios"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>
            {t === "playground" ? "Playground" : "Scenarios"}
          </button>
        ))}
      </div>
      {tab === "playground" ? (
        <Playground agent={agent} onSaved={() => setRefreshKey((k) => k + 1)} />
      ) : (
        <ScenarioManager agent={agent} refreshKey={refreshKey} />
      )}
    </div>
  );
}
