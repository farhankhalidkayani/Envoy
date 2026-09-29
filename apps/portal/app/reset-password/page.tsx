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
    <div style={{ maxWidth: 380, margin: "80px auto", padding: "0 20px" }}>
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
  );
}
