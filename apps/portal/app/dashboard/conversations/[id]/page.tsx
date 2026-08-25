"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { Conversation } from "@envoy/sdk";
import { api } from "../../../../lib/api.js";
import { errorMessage } from "../../layout.js";

export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  function load() {
    api.conversations.get(params.id).then(setConversation).catch((err) => setError(errorMessage(err)));
  }
  useEffect(load, [params.id]);

  async function rePush() {
    setPushing(true);
    setError(null);
    try {
      await api.crm.pushConversation(params.id);
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPushing(false);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!conversation) return null;

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{conversation.agent?.name ?? "Conversation"}</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 12.5, marginBottom: 20 }}>
        {new Date(conversation.createdAt).toLocaleString()} · {conversation.status}
        {conversation.outcomeType ? ` · ${conversation.outcomeType}` : ""}
      </p>

      {conversation.ruleViolationsBlocked.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--stop)" }}>
          <strong style={{ fontSize: 13.5, color: "var(--stop)", display: "block", marginBottom: 8 }}>
            {conversation.ruleViolationsBlocked.length} rule violation
            {conversation.ruleViolationsBlocked.length > 1 ? "s" : ""} blocked
          </strong>
          {conversation.ruleViolationsBlocked.map((v, i) => (
            <div key={i} style={{ fontSize: 12.5, marginBottom: 6 }}>
              <code style={{ background: "var(--stop-soft)", padding: "2px 6px", borderRadius: 4 }}>
                {v.ruleId}
              </code>{" "}
              — "{v.candidateText}" ({v.action})
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Captured data</strong>
        {Object.keys(conversation.capturedData).length === 0 ? (
          <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>Nothing captured yet.</p>
        ) : (
          <table>
            <tbody>
              {Object.entries(conversation.capturedData).map(([key, value]) => (
                <tr key={key}>
                  <td style={{ fontWeight: 600, width: 140 }}>{key}</td>
                  <td>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {conversation.status === "completed" && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              <strong style={{ fontSize: 13.5, marginRight: 8 }}>CRM</strong>
              {conversation.crmPushedAt ? (
                <span className="pill pill-ok">pushed</span>
              ) : conversation.crmPushError ? (
                <span className="pill pill-stop">failed</span>
              ) : (
                <span className="pill pill-gray">not connected</span>
              )}
            </span>
            <button className="btn" onClick={rePush} disabled={pushing} style={{ fontSize: 12.5 }}>
              {pushing ? "Pushing…" : "Re-push"}
            </button>
          </div>
          {conversation.crmPushError && (
            <p style={{ fontSize: 12.5, color: "var(--stop)", marginTop: 8 }}>{conversation.crmPushError}</p>
          )}
        </div>
      )}

      {conversation.aiSummary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>AI summary</strong>
          <p style={{ fontSize: 13 }}>{conversation.aiSummary}</p>
        </div>
      )}

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Transcript</strong>
        {conversation.transcriptText ? (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, fontFamily: "inherit", margin: 0 }}>
            {conversation.transcriptText}
          </pre>
        ) : (
          <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>
            Transcript is being generated — check back in a moment.
          </p>
        )}
      </div>
    </div>
  );
}
