"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.confirmPasswordReset(token, password);
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="card">
        <p style={{ fontSize: 13.5 }}>
          This link is missing its token. Request a new one from{" "}
          <Link href="/forgot-password">the reset page</Link>.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card">
        <p style={{ fontSize: 13.5 }}>
          Password updated — you&apos;ve been signed out everywhere for safety. Taking you to sign in…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card">
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
        {submitting ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
          <path d="M198 193l9 9 16-18" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <h2 className="auth-panel-title">Almost there</h2>
        <p className="auth-panel-text">Choose a new password — you&apos;ll be signed out everywhere else for safety.</p>
      </div>

      <div className="auth-form-side">
      <div className="auth-form-wrap">
      <h1 className="page-title page-title--tight">Set a new password</h1>
      <p style={{ color: "var(--ink-faint)", marginBottom: 24, fontSize: 13 }}>
        This link expires 1 hour after it was requested.
      </p>
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
      <p style={{ marginTop: 16, fontSize: 13 }}>
        <Link href="/login">Back to sign in</Link>
      </p>
      </div>
      </div>
    </div>
  );
}
