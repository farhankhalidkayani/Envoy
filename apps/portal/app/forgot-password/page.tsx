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
    <div style={{ maxWidth: 380, margin: "80px auto", padding: "0 20px" }}>
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
  );
}
