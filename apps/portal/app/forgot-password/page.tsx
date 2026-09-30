"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.auth.requestPasswordReset(email);
      setSent(true);
      // Only ever present in local dev, when no email provider is configured — see AuthService.requestPasswordReset.
      setDevToken(result.devToken ?? null);
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
          <rect x="150" y="150" width="120" height="90" rx="12" fill="var(--panel)" stroke="var(--line)" />
          <path d="M162 150v-20a48 48 0 0 1 96 0v20" stroke="var(--accent)" strokeWidth="6" fill="none" />
          <circle cx="210" cy="195" r="10" fill="var(--accent)" />
        </svg>
        <h2 className="auth-panel-title">We&apos;ll get you back in</h2>
        <p className="auth-panel-text">Enter the email on your workspace and we&apos;ll send a reset link.</p>
      </div>

      <div className="auth-form-side">
      <div className="auth-form-wrap">
      <h1 className="page-title page-title--tight">Reset your password</h1>
      <p style={{ color: "var(--ink-faint)", marginBottom: 24, fontSize: 13 }}>
        We&apos;ll email you a link to set a new one.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {sent ? (
        <div className="card">
          <p style={{ fontSize: 13.5 }}>
            If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 1 hour.
          </p>
          {devToken && (
            <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginTop: 12 }}>
              No email provider is configured locally —{" "}
              <Link href={`/reset-password?token=${devToken}`}>use this link directly</Link>.
            </p>
          )}
        </div>
      ) : (
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
          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p style={{ marginTop: 16, fontSize: 13 }}>
        <Link href="/login">Back to sign in</Link>
      </p>
      </div>
      </div>
    </div>
  );
}
