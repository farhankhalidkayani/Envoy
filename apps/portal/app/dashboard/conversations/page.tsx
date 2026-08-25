"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Conversation } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

const STATUS_PILL: Record<Conversation["status"], string> = {
  in_progress: "pill-warn",
  completed: "pill-ok",
  abandoned: "pill-gray",
};

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.conversations.list().then(setConversations).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div>
      <h1 className="page-title">Conversations</h1>
      {error && <div className="error-banner">{error}</div>}

      {conversations && conversations.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No conversations yet — they'll show up here once visitors start chatting.
        </div>
      )}

      {conversations && conversations.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>Started</th>
                <th>Rule violations</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td>{c.agent?.name ?? c.agentId}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[c.status]}`}>{c.status}</span>
                  </td>
                  <td>{c.outcomeType ?? "—"}</td>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td>
                    {c.ruleViolationsBlocked.length > 0 ? (
                      <span className="pill pill-stop">{c.ruleViolationsBlocked.length}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <Link href={`/dashboard/conversations/${c.id}`}>View →</Link>
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
