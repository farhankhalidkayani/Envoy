"use client";

import { useEffect, useState } from "react";
import type { Agent, AgentVersion } from "@envoy/sdk";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

/** Every configuration change is saved as a version; restoring one creates a new version, so history is never rewritten. */
export function VersionHistory({ agent, onRestored }: { agent: Agent; onRestored(agent: Agent): void }) {
  const [versions, setVersions] = useState<AgentVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agents.versions(agent.id).then(setVersions).catch((err) => setError(errorMessage(err)));
  }, [agent.id, agent.version]);

  async function restore(version: number) {
    setBusy(true);
    setError(null);
    try {
      onRestored(await api.agents.restoreVersion(agent.id, version));
      setConfirming(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Version history</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
        Every change to the script, fields, rules, widget or behavior is saved. Restoring an old version creates a new one.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {!versions && !error && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Loading…</p>}
      {versions?.map((v) => (
        <div key={v.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
          <span>
            <b>v{v.version}</b>
            {v.version === agent.version && <span className="pill pill-ok" style={{ marginLeft: 6 }}>current</span>}
            <span style={{ color: "var(--ink-faint)", marginLeft: 8 }}>
              {new Date(v.createdAt).toLocaleString()}
              {v.note ? ` · ${v.note}` : ""}
            </span>
          </span>
          {v.version !== agent.version &&
            (confirming === v.version ? (
              <span style={{ display: "flex", gap: 6 }}>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => restore(v.version)} style={{ fontSize: 12 }}>
                  {busy ? "Restoring…" : "Confirm restore"}
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(null)} style={{ fontSize: 12 }}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirming(v.version)} style={{ fontSize: 12 }}>Restore</button>
            ))}
        </div>
      ))}
    </div>
  );
}
