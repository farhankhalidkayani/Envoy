"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OAuthConsentInfo } from "@envoy/sdk";
import { API_TOKEN_SCOPES, API_TOKEN_SCOPE_LABELS, type ApiTokenScope } from "@envoy/types";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

/** An OAuth error from the API arrives as `{error, error_description}` JSON inside the error message. */
function oauthMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "";
  try {
    const body = JSON.parse(raw) as { error_description?: string; message?: string | string[] };
    return body.error_description ?? (Array.isArray(body.message) ? body.message.join(" ") : body.message) ?? raw;
  } catch {
    return raw || "Something went wrong.";
  }
}

/**
 * The consent step when an AI app (Claude, Cursor, …) connects to Envoy by signing in. The app sent the browser
 * here; the workspace owner sees which app, where it will return to, and what it may do, ticks the permissions to
 * grant, and is sent back to the app. Nothing here ever lets an app go further than an API token could.
 */
export default function OAuthAuthorizePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState<Record<string, string> | null>(null);
  const [info, setInfo] = useState<OAuthConsentInfo | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (url: string) => window.location.assign(url);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    if (user.role !== "owner") {
      setError("Only the workspace owner can connect apps. Ask them to do this, or sign in as the owner.");
      return;
    }
    const q = Object.fromEntries(new URLSearchParams(window.location.search));
    setQuery(q);
    api.oauth
      .describe(q)
      .then((r) => {
        if ("redirect_to" in r) return go(r.redirect_to); // the request itself was malformed: the app is told why
        setInfo(r);
        setChosen(new Set(r.requestedScopes));
      })
      .catch((err) => setError(oauthMessage(err)));
  }, [loading, user, router]);

  async function decide(allow: boolean) {
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      go((await (allow ? api.oauth.approve(query, [...chosen]) : api.oauth.deny(query))).redirect_to);
    } catch (err) {
      setError(oauthMessage(err));
      setBusy(false);
    }
  }

  const toggle = (s: string) => setChosen((prev) => { const next = new Set(prev); next.has(s) ? next.delete(s) : next.add(s); return next; });

  return (
    <div className="auth-shell">
      <div className="card" style={{ maxWidth: 460, margin: "60px auto", padding: 24 }}>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!info && !error && <p>Loading…</p>}
        {info && (
          <>
            <h1 style={{ fontSize: 18, marginBottom: 6 }}>Connect “{info.client.name}” to Envoy?</h1>
            <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 14 }}>
              The name is what the app calls itself. You&apos;ll be sent back to <b>{info.redirectHost}</b>. Only continue if you started this from that app just now.
            </p>
            <strong style={{ fontSize: 13 }}>It will be able to:</strong>
            <div style={{ margin: "8px 0 12px" }}>
              {(API_TOKEN_SCOPES as readonly ApiTokenScope[]).filter((s) => info.requestedScopes.includes(s)).map((s) => (
                <label key={s} style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
                  <input type="checkbox" checked={chosen.has(s)} onChange={() => toggle(s)} />
                  <span>{API_TOKEN_SCOPE_LABELS[s]} <code style={{ fontSize: 11, color: "var(--ink-faint)" }}>{s}</code></span>
                </label>
              ))}
            </div>
            {info.unknownScopes.length > 0 && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>It also asked for {info.unknownScopes.join(", ")}, which Envoy doesn&apos;t have; those are ignored.</p>}
            <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "10px 0 16px" }}>
              It acts as you, within these permissions. It can never publish agents, change hard rules, approve requests, or touch billing, keys or tokens — it can only ask you. You can disconnect it any time under API &amp; MCP.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={() => decide(true)}>Allow</button>
              <button type="button" className="btn" disabled={busy} onClick={() => decide(false)}>Deny</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
