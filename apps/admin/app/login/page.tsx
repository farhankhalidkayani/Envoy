"use client";

import { useState } from "react";
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
      router.push("/tenants");
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
          <rect x="70" y="90" width="280" height="200" rx="14" fill="#16211e" stroke="var(--sidebar-line)" />
          <rect x="70" y="90" width="280" height="34" rx="14" fill="var(--accent)" opacity="0.9" />
          <circle cx="92" cy="107" r="4" fill="#0e1a17" />
          <circle cx="104" cy="107" r="4" fill="#0e1a17" />
          <circle cx="116" cy="107" r="4" fill="#0e1a17" />
          <rect x="92" y="146" width="90" height="70" rx="8" fill="#1e2c28" stroke="var(--line)" />
          <rect x="192" y="146" width="136" height="32" rx="6" fill="var(--accent-soft)" />
          <rect x="192" y="186" width="136" height="32" rx="6" fill="#1e2c28" stroke="var(--line)" />
          <rect x="92" y="230" width="236" height="36" rx="8" fill="#1e2c28" stroke="var(--line)" />
          <circle cx="360" cy="80" r="18" fill="var(--accent)" opacity="0.35" />
          <circle cx="60" cy="300" r="12" fill="var(--accent)" opacity="0.3" />
        </svg>
        <h2 className="auth-panel-title">Operator console</h2>
        <p className="auth-panel-text">
          Manage tenants, review platform-wide usage, and step in on integrations or billing issues across every
          workspace.
        </p>
      </div>

      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <h1 className="page-title page-title--tight">Envoy Operator Console</h1>
          <p style={{ color: "var(--ink-faint)", marginBottom: 24, fontSize: 13 }}>platform_admin access only</p>

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
        </div>
      </div>
    </div>
  );
}
