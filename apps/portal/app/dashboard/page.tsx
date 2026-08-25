"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Agent } from "@envoy/sdk";
import { api } from "../../lib/api.js";
import { errorMessage } from "./layout.js";

const STATUS_PILL: Record<Agent["status"], string> = {
  draft: "pill-gray",
  live: "pill-ok",
  paused: "pill-warn",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents.list().then(setAgents).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 20 }}>Agents</h1>
        <Link href="/dashboard/agents/new" className="btn btn-primary">
          + New agent
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {agents && agents.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No agents yet. Create one to get your embed snippet.
        </div>
      )}

      {agents && agents.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[agent.status]}`}>{agent.status}</span>
                  </td>
                  <td>{new Date(agent.createdAt).toLocaleDateString()}</td>
                  <td>
                    <Link href={`/dashboard/agents/${agent.id}`}>Configure →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
