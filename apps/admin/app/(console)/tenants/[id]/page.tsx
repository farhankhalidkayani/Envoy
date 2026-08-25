"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { AdminTenantDetail } from "@envoy/sdk";
import type { FeatureKey } from "@envoy/types";
import { FEATURE_KEYS } from "@envoy/types";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../layout";

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<AdminTenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [baseMonthly, setBaseMonthly] = useState("");
  const [perConversation, setPerConversation] = useState("");
  const [included, setIncluded] = useState("");
  const [voiceAddOn, setVoiceAddOn] = useState(false);

  function load() {
    api.admin
      .getTenant(params.id)
      .then((t) => {
        setTenant(t);
        // Tenant.priceConfig only gets populated once an admin sets a custom
        // override — until then it's `{}`. Show the tenant's actual current
        // rate by falling back to the subscription's starter-plan values,
        // not a blank/zeroed form.
        setBaseMonthly(
          String((t.priceConfig.baseMonthlyCents as number | undefined) ?? t.subscription?.monthlyRate ?? 0),
        );
        setPerConversation(
          String((t.priceConfig.perConversationCents as number | undefined) ?? t.subscription?.usageRate ?? 0),
        );
        setIncluded(
          String(
            (t.priceConfig.includedConversations as number | undefined) ??
              t.subscription?.includedConversations ??
              0,
          ),
        );
        setVoiceAddOn(
          Boolean((t.priceConfig.addOns as { voice?: boolean } | undefined)?.voice),
        );
      })
      .catch((err) => setError(errorMessage(err)));
  }

  useEffect(load, [params.id]);

  async function savePricing(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const existingAddOns = tenant?.priceConfig.addOns as { crm?: boolean; voice?: boolean } | undefined;
      await api.admin.updatePricing(params.id, {
        baseMonthlyCents: Number(baseMonthly),
        perConversationCents: Number(perConversation),
        includedConversations: Number(included),
        addOns: { crm: Boolean(existingAddOns?.crm), voice: voiceAddOn },
      });
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleFeature(userId: string, feature: FeatureKey, current: boolean) {
    setError(null);
    try {
      await api.admin.updateUserAccess(params.id, userId, { [feature]: !current });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (error && !tenant) return <div className="error-banner">{error}</div>;
  if (!tenant) return null;

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{tenant.name}</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 12.5, marginBottom: 20 }}>
        {tenant._count.agents} agents · {tenant._count.users} users · {tenant._count.conversations}{" "}
        conversations
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 12 }}>Custom pricing</strong>
        <form onSubmit={savePricing} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label>Base monthly (cents)</label>
            <input value={baseMonthly} onInput={(e) => setBaseMonthly((e.target as HTMLInputElement).value)} />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label>Per-conversation (cents)</label>
            <input
              value={perConversation}
              onInput={(e) => setPerConversation((e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label>Included / mo</label>
            <input value={included} onInput={(e) => setIncluded((e.target as HTMLInputElement).value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={voiceAddOn}
                onChange={(e) => setVoiceAddOn((e.target as HTMLInputElement).checked)}
              />
              Voice add-on
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            Save
          </button>
        </form>
      </div>

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 12 }}>User feature access</strong>
        <table>
          <thead>
            <tr>
              <th>User</th>
              {FEATURE_KEYS.map((f) => (
                <th key={f}>{f}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenant.users.map((user) => (
              <tr key={user.id}>
                <td>{user.email}</td>
                {FEATURE_KEYS.map((feature) => {
                  const enabled = Boolean(user.featureAccess[feature]);
                  return (
                    <td key={feature}>
                      <button
                        className={`pill ${enabled ? "pill-ok" : "pill-gray"}`}
                        style={{ border: "none" }}
                        onClick={() => toggleFeature(user.id, feature, enabled)}
                      >
                        {enabled ? "on" : "off"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
