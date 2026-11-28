"use client";

import { useCallback, useEffect, useState } from "react";
import type { OperatorToken } from "@envoy/sdk";
import { OPERATOR_SCOPES, OPERATOR_SCOPE_LABELS, OPERATOR_TOKEN_MAX_DAYS, type OperatorScope } from "@envoy/types";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const statusOf = (t: OperatorToken) => (t.revokedAt ? "revoked" : new Date(t.expiresAt) <= new Date() ? "expired" : "active");

/**
 * Tokens for the operator's own AI assistant, used with the operator MCP server (local, stdio). Read-only unless
 * write access is ticked; short-lived; never able to touch pricing, charges, deletion or tokens.
 */
export default function AiAccessPage() {
  const { showToast } = useToast();
  const [tokens, setTokens] = useState<OperatorToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<OperatorScope[]>(["admin:read"]);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.admin.operatorTokens.list().then(setTokens).catch((err) => setError(errorMessage(err))), []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.admin.operatorTokens.create({ name, scopes, expiresInDays: days });
      setCreated(t.token);
      setName("");
      setScopes(["admin:read"]);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: OperatorToken) {
    try {
      await api.admin.operatorTokens.revoke(t.id);
      showToast("Token revoked. It stopped working immediately.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const toggle = (s: OperatorScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const config = created && JSON.stringify({ mcpServers: { "envoy-operator": { command: "node", args: ["/path/to/Envoy/apps/mcp/dist/stdio-operator.js"], env: { ENVOY_API_URL: "https://your-api", ENVOY_OPERATOR_TOKEN: created } } } }, null, 2);

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="page-title">AI access</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 12.5, marginBottom: 16 }}>
        Let your own AI assistant help run the platform through the operator MCP server, which runs on your machine. It acts as you, within the access you
        tick, and everything it changes is in the audit log under the token&apos;s name. It can never change pricing, charge a tenant, delete a tenant or manage
        these tokens — those stay with you, here.
      </p>
      {error && <div className="error-banner" role="alert">{error}</div>}

      {created && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13 }}>Copy this token now — it won&apos;t be shown again.</strong>
          <code style={{ display: "block", margin: "8px 0", wordBreak: "break-all" }}>{created}</code>
          <pre aria-label="MCP config" style={{ fontSize: 11.5, whiteSpace: "pre-wrap" }}>{config}</pre>
          <button type="button" className="btn" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}

      <form onSubmit={create} className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>New operator token</strong>
        <div className="field">
          <label htmlFor="op-name">Name</label>
          <input id="op-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude on my laptop" />
        </div>
        <div className="field">
          <label>Access</label>
          {OPERATOR_SCOPES.map((s) => (
            <label key={s} style={{ display: "flex", gap: 8, fontSize: 12.5, marginBottom: 4 }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              <span><code>{s}</code> — {OPERATOR_SCOPE_LABELS[s]}</span>
            </label>
          ))}
          {scopes.includes("admin:write") && <p style={{ fontSize: 12, color: "var(--warn)" }}>With write access, the assistant can pause a tenant, which stops all of that business&apos;s agents.</p>}
        </div>
        <div className="field">
          <label htmlFor="op-days">Expires after</label>
          <select id="op-days" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }}>
            <option value={1}>1 day</option><option value={7}>7 days</option><option value={OPERATOR_TOKEN_MAX_DAYS}>{OPERATOR_TOKEN_MAX_DAYS} days</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || scopes.length === 0 || !name.trim()}>{busy ? "Creating…" : "Create token"}</button>
      </form>

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Tokens</strong>
        {tokens?.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>None yet. Without a token, no AI assistant can reach the operator API.</p>}
        {tokens?.map((t) => {
          const status = statusOf(t);
          return (
            <div key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13, opacity: status === "active" ? 1 : 0.6 }}>
              <span style={{ flex: 1 }}>
                <b>{t.name}</b> <span style={{ color: "var(--ink-faint)" }}>· envoy_op_…{t.last4}</span>{" "}
                <span className={`pill ${status === "active" ? "pill-ok" : "pill-gray"}`}>{status}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>
                  {t.scopes.join(", ")} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"} · expires {new Date(t.expiresAt).toLocaleDateString()}
                </span>
              </span>
              {status === "active" && <button type="button" className="btn" aria-label={`Revoke ${t.name}`} onClick={() => revoke(t)} style={{ fontSize: 12 }}>Revoke</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
