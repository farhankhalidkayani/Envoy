"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

function VerifyEmailBody() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"pending" | "done" | "error">("pending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("error");
      setError("This link is missing its token.");
      return;
    }
    api.auth
      .confirmEmailVerification(token)
      .then(() => setState("done"))
      .catch((err) => {
        setState("error");
        setError(errorMessage(err));
      });
  }, [token]);

  if (state === "pending") return <p style={{ fontSize: 13.5 }}>Verifying…</p>;
  if (state === "done") {
    return (
      <div className="card">
        <p style={{ fontSize: 13.5 }}>Your email is verified.</p>
        <Link href="/dashboard" className="btn btn-primary" style={{ marginTop: 12, display: "inline-block" }}>
          Go to dashboard
        </Link>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="error-banner">{error}</div>
      <p style={{ fontSize: 13.5, marginTop: 8 }}>
        Sign in and request a new verification email from your dashboard.
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div style={{ maxWidth: 380, margin: "80px auto", padding: "0 20px" }}>
      <h1 className="page-title page-title--tight">Verify your email</h1>
      <Suspense fallback={null}>
        <VerifyEmailBody />
      </Suspense>
    </div>
  );
}
