"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BillingUsage, Subscription } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const STATUS_PILL: Record<Subscription["status"], string> = {
  active: "pill-ok",
  past_due: "pill-warn",
  locked: "pill-stop",
  cancelled: "pill-gray",
};

function cents(n: number) {
  return `$${(n / 100).toFixed(2)}`;
}

/** Reads ?checkout=success|cancelled once (from the Stripe redirect back), then strips it from the URL. */
function CheckoutReturnBanner() {
  const params = useSearchParams();
  const { showToast } = useToast();
  const checkout = params.get("checkout");

  useEffect(() => {
    if (!checkout) return;
    showToast(checkout === "success" ? "Payment method saved — you're all set." : "Checkout cancelled.");
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

  return null;
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<"checkout" | "portal" | null>(null);

  function load() {
    api.billing.getSubscription().then(setSubscription).catch((err) => setError(errorMessage(err)));
    api.billing.getUsage().then(setUsage).catch(() => {});
  }
  useEffect(load, []);

  async function goTo(action: "checkout" | "portal") {
    setRedirecting(action);
    setError(null);
    try {
      const result = action === "checkout" ? await api.billing.checkout() : await api.billing.portal();
      if (result.mode === "stripe" && result.url) {
        window.location.href = result.url;
        return;
      }
      // Mock mode: no live Stripe account configured — nothing to redirect to.
      setError(
        action === "checkout"
          ? "This account is already active — real payment collection isn't configured on this server yet."
          : "Billing management isn't available until a live Stripe account is configured on this server.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRedirecting(null);
    }
  }

  const usingRealStripe = subscription && !subscription.stripeCustomerId?.startsWith("local_");

  return (
    <div style={{ maxWidth: 480 }}>
      <Suspense fallback={null}>
        <CheckoutReturnBanner />
      </Suspense>
      <h1 className="page-title">Billing</h1>
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
              Payment is past due and your account is locked. Add a payment method below to restore access.
            </p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {usingRealStripe ? (
              <button className="btn btn-primary" onClick={() => goTo("portal")} disabled={redirecting !== null}>
                {redirecting === "portal" ? "Redirecting…" : "Manage billing"}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => goTo("checkout")} disabled={redirecting !== null}>
                {redirecting === "checkout" ? "Redirecting…" : "Add payment method"}
              </button>
            )}
          </div>
        </div>
      )}

      {usage && (
        <div className="card" style={{ marginTop: 16 }}>
          <strong style={{ fontSize: 14, display: "block", marginBottom: 4 }}>Usage this cycle</strong>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
            {new Date(usage.cycleStart).toLocaleDateString()} – {new Date(usage.cycleEnd).toLocaleDateString()}
          </p>
          <div
            style={{
              height: 8,
              borderRadius: 999,
              background: "var(--paper)",
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, (usage.usedConversations / Math.max(1, usage.includedConversations)) * 100)}%`,
                background: usage.overageConversations > 0 ? "var(--warn)" : "var(--accent)",
              }}
            />
          </div>
          <p style={{ fontSize: 13 }}>
            {usage.usedConversations} / {usage.includedConversations} conversations included
          </p>
          {usage.overageConversations > 0 && (
            <p style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 4 }}>
              {usage.overageConversations} over — estimated {cents(usage.overageAmountCents)} overage this cycle
            </p>
          )}
        </div>
      )}
    </div>
  );
}
