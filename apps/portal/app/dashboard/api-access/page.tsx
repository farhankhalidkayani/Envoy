"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiToken, CreatedApiToken } from "@envoy/sdk";
import { API_TOKEN_SCOPES, API_TOKEN_SCOPE_LABELS, type ApiTokenScope } from "@envoy/types";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const PRESETS: Array<{ label: string; help: string; scopes: ApiTokenScope[] }> = [
  { label: "Read only", help: "See agents, conversations and leads.", scopes: ["agents:read", "conversations:read", "forms:read", "models:read", "billing:read", "integrations:read"] },
  { label: "Build & test agents", help: "Read everything, create and edit agents, run the playground and scenarios — and ask you to approve the things only you can do.", scopes: ["agents:read", "agents:write", "conversations:read", "models:read", "approvals:read", "approvals:write"] },
];

const statusOf = (t: ApiToken) => (t.revokedAt ? "revoked" : new Date(t.expiresAt) <= new Date() ? "expired" : "active");

/** What to paste into an MCP-capable AI app. The token itself is only known at creation, so the snippet is shown with it. */
function mcpConfig(token: string) {
  return JSON.stringify({ mcpServers: { envoy: { command: "npx", args: ["-y", "@envoy/mcp"], env: { ENVOY_API_URL: API_URL, ENVOY_API_TOKEN: token } } } }, null, 2);
}

export default function ApiAccessPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isOwner = user?.role === "owner";
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(PRESETS[1]!.scopes);
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await api.tokens.list());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { if (isOwner) void load(); else setTokens([]); }, [isOwner, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      setCreated(await api.tokens.create({ name: name.trim(), scopes, expiresInDays: days }));
      setName("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(t: ApiToken) {
    try {
      await api.tokens.revoke(t.id);
      showToast("Token revoked — it stops working immediately.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const toggle = (s: ApiTokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 className="page-title">API &amp; MCP</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 13, marginBottom: 12 }}>
        Let an AI assistant (Claude, ChatGPT, Cursor…) or your own scripts work in this workspace through a personal API token. The assistant can build
        and test agents, read conversations and leads, and draft improvements — within the scopes you choose.
      </p>
      <div className="card" style={{ marginBottom: 16, fontSize: 12.5 }}>
        <b>What a token can never do:</b> publish an agent to visitors, change its hard rules, approve a proposed improvement, give an agent access to your CRM or
        calendar, or touch billing, AI model keys, your account or other tokens. Those always need you, here in the portal. Every change a token makes is recorded
        in your audit log.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!isOwner && <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>Only the workspace owner can create and revoke API tokens.</div>}

      {created && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--ok, #2f9e5b)" }} role="status">
          <strong style={{ fontSize: 13.5 }}>Token “{created.name}” created — copy it now</strong>
          <p style={{ fontSize: 12.5, margin: "6px 0" }}>This is the only time it will be shown. Store it somewhere safe; if you lose it, revoke it and make a new one.</p>
          <code aria-label="New token" style={{ display: "block", background: "var(--paper)", padding: 10, borderRadius: 6, wordBreak: "break-all", fontSize: 12.5 }}>{created.token}</code>
          <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
            <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(created.token).then(() => showToast("Copied."))}>Copy token</button>
            <button type="button" className="btn" onClick={() => setCreated(null)}>I&apos;ve saved it</button>
          </div>
          <strong style={{ fontSize: 12.5 }}>Add it to an MCP app</strong>
          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "2px 0 6px" }}>Paste into your app&apos;s MCP settings (for Claude Desktop: claude_desktop_config.json):</p>
          <pre aria-label="MCP configuration" style={{ background: "var(--paper)", padding: 10, borderRadius: 6, fontSize: 12, overflowX: "auto", margin: 0 }}>{mcpConfig(created.token)}</pre>
        </div>
      )}

      {isOwner && (
        <form onSubmit={create} className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>New token</strong>
          <div className="field">
            <label htmlFor="tok-name">Name</label>
            <input id="tok-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude desktop" />
          </div>
          <div className="field">
            <label>What it can do</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {PRESETS.map((p) => <button key={p.label} type="button" className="btn" title={p.help} onClick={() => setScopes(p.scopes)} style={{ fontSize: 12.5 }}>{p.label}</button>)}
            </div>
            {API_TOKEN_SCOPES.map((s) => (
              <label key={s} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, marginBottom: 4 }}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} style={{ marginTop: 2 }} />
                <span><code>{s}</code> — {API_TOKEN_SCOPE_LABELS[s]}</span>
              </label>
            ))}
          </div>
          <div className="field">
            <label htmlFor="tok-days">Expires after</label>
            <select id="tok-days" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }}>
              <option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating || scopes.length === 0 || !name.trim()}>{creating ? "Creating…" : "Create token"}</button>
        </form>
      )}

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Tokens</strong>
        {!tokens && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Loading…</p>}
        {tokens?.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No tokens yet.</p>}
        {tokens?.map((t) => {
          const status = statusOf(t);
          return (
            <div key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13, opacity: status === "active" ? 1 : 0.6 }}>
              <span style={{ flex: 1 }}>
                <b>{t.name}</b> <span style={{ color: "var(--ink-faint)" }}>· envoy_sk_…{t.last4}</span>
                <span className={`pill ${status === "active" ? "pill-ok" : "pill-gray"}`} style={{ marginLeft: 8 }}>{status}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>{t.scopes.join(", ")}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>
                  {t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleString()}` : "Never used"} · expires {new Date(t.expiresAt).toLocaleDateString()}
                </span>
              </span>
              {isOwner && status === "active" && <button type="button" className="btn" onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`} style={{ fontSize: 12 }}>Revoke</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
