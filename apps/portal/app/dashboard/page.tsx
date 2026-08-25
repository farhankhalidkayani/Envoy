"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Agent, Conversation } from "@envoy/sdk";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { BotIcon, PulseIcon, ChatIcon, CheckCircleIcon } from "../../components/icons";

const STATUS_PILL: Record<Agent["status"], string> = {
  draft: "pill-gray",
  live: "pill-ok",
  paused: "pill-warn",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents.list().then(setAgents).catch((err) => setError(errorMessage(err)));
    api.conversations.list().then(setConversations).catch(() => {});
  }, []);

  const liveAgents = agents?.filter((a) => a.status === "live").length ?? 0;
  const totalConversations = conversations?.length ?? 0;
  const completed = conversations?.filter((c) => c.status === "completed").length ?? 0;
  const completionRate = totalConversations > 0 ? Math.round((completed / totalConversations) * 100) : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 className="page-title page-title--flush">Agents</h1>
        <Link href="/dashboard/agents/new" className="btn btn-primary">
          + New agent
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {agents && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <BotIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{agents.length}</div>
            <div className="stat-card-label">Total agents</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <PulseIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{liveAgents}</div>
            <div className="stat-card-label">Live now</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <ChatIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{totalConversations}</div>
            <div className="stat-card-label">Conversations</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <CheckCircleIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{completionRate !== null ? `${completionRate}%` : "—"}</div>
            <div className="stat-card-label">Completion rate</div>
          </div>
        </div>
      )}

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
