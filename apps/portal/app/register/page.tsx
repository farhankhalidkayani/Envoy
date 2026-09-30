"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/errors";

export default function RegisterPage() {
  const { setSession } = useAuth();
  const router = useRouter();
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.auth.register({ tenantName, email, password });
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
          <circle cx="210" cy="190" r="70" fill="var(--panel)" stroke="var(--line)" />
          <path d="M182 190l20 20 36-40" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx="330" cy="100" r="22" fill="var(--accent-2)" opacity="0.5" />
          <circle cx="90" cy="260" r="14" fill="var(--accent)" opacity="0.4" />
        </svg>
        <h2 className="auth-panel-title">Free to start, no card required</h2>
        <p className="auth-panel-text">
          Create a workspace, configure your first agent, and get a working embed on your site in under ten
          minutes.
        </p>
      </div>

      <div className="auth-form-side">
      <div className="auth-form-wrap">
      <h1 className="page-title page-title--tight">Create your workspace</h1>
      <p style={{ color: "var(--ink-faint)", marginBottom: 24, fontSize: 13 }}>
        Free to start — no card required.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={onSubmit} className="card">
        <div className="field">
          <label htmlFor="tenantName">Business name</label>
          <input
            id="tenantName"
            autoComplete="organization"
            required
            value={tenantName}
            onInput={(e) => setTenantName((e.target as HTMLInputElement).value)}
          />
        </div>
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>At least 8 characters.</p>
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
          {submitting ? "Creating…" : "Create workspace"}
        </button>
      </form>

      <p style={{ marginTop: 16, fontSize: 13 }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
      </div>
      </div>
    </div>
  );
}
