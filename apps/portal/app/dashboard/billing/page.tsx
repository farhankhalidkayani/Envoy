"use client";

import { useEffect, useState } from "react";
import type { Subscription } from "@envoy/sdk";
import { api } from "../../../lib/api.js";
import { errorMessage } from "../layout.js";

const STATUS_PILL: Record<Subscription["status"], string> = {
  active: "pill-ok",
  past_due: "pill-warn",
  locked: "pill-stop",
  cancelled: "pill-gray",
};

function cents(n: number) {
  return `$${(n / 100).toFixed(2)}`;
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.billing.getSubscription().then(setSubscription).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 20, marginBottom: 20 }}>Billing</h1>
      {error && <div className="error-banner">{error}</div>}

      {subscription && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <strong style={{ fontSize: 14 }}>Subscription</strong>
            <span className={`pill ${STATUS_PILL[subscription.status]}`}>{subscription.status}</span>
          </div>
          <table>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600 }}>Monthly rate</td>
                <td>{cents(subscription.monthlyRate)}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Included conversations</td>
                <td>{subscription.includedConversations} / month</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Overage rate</td>
                <td>{cents(subscription.usageRate)} / conversation</td>
              </tr>
            </tbody>
          </table>
          {subscription.status === "locked" && (
            <p style={{ fontSize: 12.5, color: "var(--stop)", marginTop: 14 }}>
              Payment is past due and your account is locked. Contact support to resolve — real
              payment collection (Stripe checkout) isn't wired into this demo build.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
