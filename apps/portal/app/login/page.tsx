"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/errors";

export default function LoginPage() {
  const { setSession } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.auth.login({ email, password });
      setSession(result);
      router.push("/dashboard");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <svg className="auth-art" viewBox="0 0 420 420" fill="none" aria-hidden>
          <path
            d="M60 140c0-50 46-90 110-90s130 34 150 84c18 46 4 96-38 128-40 30-58 66-108 66-62 0-118-38-134-98C24 194 32 168 60 140z"
            fill="var(--accent-soft)"
          />
          <rect x="108" y="108" width="204" height="150" rx="16" fill="var(--panel)" stroke="var(--line)" />
          <rect x="108" y="108" width="204" height="38" rx="16" fill="var(--accent)" />
          <circle cx="128" cy="127" r="4" fill="#fff" opacity="0.8" />
          <circle cx="140" cy="127" r="4" fill="#fff" opacity="0.8" />
          <rect x="126" y="166" width="120" height="14" rx="7" fill="var(--paper)" />
          <rect x="126" y="190" width="150" height="14" rx="7" fill="var(--paper)" />
          <rect x="196" y="216" width="80" height="26" rx="13" fill="var(--accent)" />
          <circle cx="330" cy="100" r="22" fill="var(--accent-2)" opacity="0.5" />
          <circle cx="90" cy="260" r="14" fill="var(--accent)" opacity="0.4" />
        </svg>
        <h2 className="auth-panel-title">A branded agent, live on your site in minutes</h2>
        <p className="auth-panel-text">
          Capture leads through conversation, route them to your CRM, and keep every visitor on a rule-governed
          script — no engineering required.
        </p>
      </div>

      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <h1 className="page-title page-title--tight">Envoy</h1>
          <p style={{ color: "var(--ink-faint)", marginBottom: 24, fontSize: 13 }}>Sign in to your workspace</p>

          {error && <div className="error-banner">{error}</div>}

          <form onSubmit={onSubmit} className="card">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p style={{ marginTop: 16, fontSize: 13 }}>
            New here? <Link href="/register">Create a workspace</Link>
          </p>
          <p style={{ marginTop: 4, fontSize: 13 }}>
            <Link href="/forgot-password">Forgot your password?</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
