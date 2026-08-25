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
    <div style={{ maxWidth: 380, margin: "80px auto", padding: "0 20px" }}>
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
  );
}
