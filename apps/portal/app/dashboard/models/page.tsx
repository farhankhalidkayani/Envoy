"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalog, ModelCredential, ModelStatus, ModelUsageSummary } from "@envoy/sdk";
import {
  MODEL_PRESETS,
  MODEL_ROLES,
  PRESET_LABELS,
  PROVIDER_LABELS,
  presetModels,
  type ModelConfig,
  type ModelPreset,
  type ModelProviderKind,
  type ModelRole,
} from "@envoy/types";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

const ROLE_LABELS: Record<ModelRole, { label: string; help: string }> = {
  chat: { label: "Replies", help: "What visitors read. The most important place for a strong model." },
  judge: { label: "Rule checks", help: "Checks every reply against your hard rules before it's sent." },
  extract: { label: "Data capture", help: "Pulls field values out of what visitors say." },
  summarize: { label: "Summaries", help: "Writes the AI summary of a finished conversation." },
};

export default function ModelsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isOwner = user?.role === "owner";

  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [creds, setCreds] = useState<ModelCredential[] | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [usage, setUsage] = useState<ModelUsageSummary | null>(null);
  const [config, setConfig] = useState<ModelConfig>({ allowPlatformFallback: true });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, cr, st, cfg, u] = await Promise.all([
        api.models.catalog(), api.models.listCredentials(), api.models.status(), api.models.getConfig(), api.models.usage(30),
      ]);
      setCatalog(c); setCreds(cr); setStatus(st); setConfig(cfg); setUsage(u);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // ── add key ──
  const [provider, setProvider] = useState<ModelProviderKind>("anthropic");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testModel, setTestModel] = useState("");
  const [adding, setAdding] = useState(false);
  const custom = provider === "openai_compatible";

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await api.models.addCredential({
        provider,
        label: label.trim() || PROVIDER_LABELS[provider],
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        testModel: testModel.trim() || undefined,
      });
      setApiKey(""); setLabel(""); setBaseUrl(""); setTestModel("");
      showToast("Key verified and saved.");
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function testKey(c: ModelCredential) {
    try {
      const result = await api.models.testCredential(c.id);
      showToast(result.ok ? "Key works." : result.error);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeKey(c: ModelCredential) {
    try {
      await api.models.deleteCredential(c.id);
      showToast("Key removed.");
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // ── assign models ──
  const [presetCred, setPresetCred] = useState("");
  const active = (creds ?? []).filter((c) => c.status === "active");
  const providerOf = (id: string) => creds?.find((c) => c.id === id)?.provider;
  const suggestions = (id: string) => {
    const p = providerOf(id);
    return p && p !== "openai_compatible" ? catalog?.providers.find((x) => x.id === p)?.models ?? [] : [];
  };

  function applyPreset(preset: ModelPreset) {
    const credentialId = presetCred || active[0]?.id;
    const provider = credentialId ? providerOf(credentialId) : undefined;
    const models = provider ? presetModels(provider, preset) : null;
    if (!credentialId || !models) {
      setError("That key has no preset — pick the model for each job by hand.");
      return;
    }
    setConfig((c) => ({ ...c, ...Object.fromEntries(MODEL_ROLES.map((r) => [r, { credentialId, model: models[r] }])) }));
  }

  function setRole(role: ModelRole, patch: Partial<{ credentialId: string; model: string }> | null) {
    setConfig((c) => {
      const next = { ...c } as Record<string, unknown>;
      if (patch === null) delete next[role];
      else next[role] = { credentialId: "", model: "", ...(c[role] ?? {}), ...patch };
      return next as ModelConfig;
    });
  }

  async function saveConfig() {
    setError(null);
    const cleaned = { ...config } as Record<string, unknown>;
    for (const r of MODEL_ROLES) {
      const choice = cleaned[r] as { credentialId: string; model: string } | undefined;
      if (choice && (!choice.credentialId || !choice.model.trim())) delete cleaned[r];
    }
    try {
      await api.models.setConfig(cleaned as ModelConfig);
      showToast("Model settings saved.");
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const disabled = !isOwner;

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="page-title">AI models</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 13, marginBottom: 20 }}>
        Your agents use a shared default model unless you connect your own. A strong model of your choice makes agents follow
        instructions and rules more reliably, call tools correctly and capture details accurately. Your provider bills you directly
        for usage — Envoy doesn&apos;t mark it up. Keys are encrypted and never shown again.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {!isOwner && <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>Only the workspace owner can change these settings.</div>}

      {status?.usingPlatformDefault && (
        <div className="model-banner" role="status">
          <span><strong>Recommended:</strong> connect your own key below. Until then everything runs on the shared default model.</span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>API keys</strong>
        {!creds && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Loading…</p>}
        {creds?.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No keys yet.</p>}
        {creds?.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
            <span style={{ flex: 1 }}>
              <b>{c.label}</b> <span style={{ color: "var(--ink-faint)" }}>· {PROVIDER_LABELS[c.provider]} · ••••{c.last4}</span>
              {c.status === "invalid" ? <span className="pill pill-stop" style={{ marginLeft: 8 }}>rejected</span> : <span className="pill pill-ok" style={{ marginLeft: 8 }}>active</span>}
              {c.lastError && c.status === "invalid" && <span style={{ display: "block", fontSize: 12, color: "var(--stop)" }}>{c.lastError}</span>}
              <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>
                {c.lastUsedAt ? `Last used ${new Date(c.lastUsedAt).toLocaleString()}` : "Not used yet"}
              </span>
            </span>
            <button type="button" className="btn" disabled={disabled} onClick={() => testKey(c)} style={{ fontSize: 12 }}>Test</button>
            <button type="button" className="btn" disabled={disabled} onClick={() => removeKey(c)} style={{ fontSize: 12 }} aria-label={`Remove ${c.label}`}>Remove</button>
          </div>
        ))}

        {isOwner && (
          <form onSubmit={addKey} style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 14 }}>
            <strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>Add a key</strong>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: "1 1 180px" }}>
                <label htmlFor="provider">Provider</label>
                <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value as ModelProviderKind)}>
                  {Object.entries(PROVIDER_LABELS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: "1 1 180px" }}>
                <label htmlFor="label">Name (optional)</label>
                <input id="label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Production" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="apikey">API key</label>
              <input id="apikey" type="password" autoComplete="off" required minLength={8} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste your key" />
            </div>
            {custom && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div className="field" style={{ flex: "2 1 260px" }}>
                  <label htmlFor="baseurl">Base URL</label>
                  <input id="baseurl" type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                </div>
                <div className="field" style={{ flex: "1 1 160px" }}>
                  <label htmlFor="testmodel">Model to test with</label>
                  <input id="testmodel" required value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="model name" />
                </div>
              </div>
            )}
            <button type="submit" className="btn btn-primary" disabled={adding}>{adding ? "Verifying…" : "Verify & save"}</button>
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 6 }}>
              We make one tiny test request to confirm the key works before saving it.
            </p>
          </form>
        )}
      </div>

      {active.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Which model does what</strong>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
            Start from a preset, then adjust any job. Jobs left blank use the shared default model.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <select aria-label="Key for preset" value={presetCred || active[0]!.id} disabled={disabled} onChange={(e) => setPresetCred(e.target.value)} style={{ width: 200 }}>
              {active.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {MODEL_PRESETS.map((p) => (
              <button key={p} type="button" className="btn" disabled={disabled} title={PRESET_LABELS[p].help} onClick={() => applyPreset(p)} style={{ fontSize: 12.5 }}>
                {PRESET_LABELS[p].label}
              </button>
            ))}
          </div>

          {MODEL_ROLES.map((role) => {
            const choice = config[role];
            return (
              <div key={role} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ width: 130, fontSize: 13 }} title={ROLE_LABELS[role].help}><b>{ROLE_LABELS[role].label}</b></span>
                <select
                  aria-label={`${ROLE_LABELS[role].label} key`}
                  value={choice?.credentialId ?? ""}
                  disabled={disabled}
                  onChange={(e) => (e.target.value ? setRole(role, { credentialId: e.target.value }) : setRole(role, null))}
                  style={{ width: 180 }}
                >
                  <option value="">Shared default</option>
                  {active.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                {choice && (
                  <>
                    <input
                      aria-label={`${ROLE_LABELS[role].label} model`}
                      list={`models-${role}`}
                      value={choice.model}
                      disabled={disabled}
                      onChange={(e) => setRole(role, { model: e.target.value })}
                      placeholder="model name"
                      style={{ width: 200 }}
                    />
                    <datalist id={`models-${role}`}>{suggestions(choice.credentialId).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
                  </>
                )}
              </div>
            );
          })}

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 12.5 }}>
            <input type="checkbox" checked={config.allowPlatformFallback} disabled={disabled} onChange={(e) => setConfig((c) => ({ ...c, allowPlatformFallback: e.target.checked }))} style={{ marginTop: 2 }} />
            <span>
              <b>Fall back to the shared model if my key fails</b> (rejected, out of credit, rate-limited, or the provider is down) so
              visitors still get an answer. Turn off to fail loudly instead.
            </span>
          </label>
          {isOwner && <button type="button" className="btn btn-primary" onClick={saveConfig} style={{ marginTop: 14 }}>Save model settings</button>}
        </div>
      )}

      <div className="card">
        <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>Usage, last 30 days</strong>
        {!usage || usage.rows.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No model calls yet.</p>
        ) : (
          <table>
            <thead><tr><th>Model</th><th>Job</th><th>Source</th><th>Calls</th><th>Tokens in / out</th><th>Failed</th></tr></thead>
            <tbody>
              {usage.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.model}</td><td>{r.role}</td>
                  <td>{r.keySource === "tenant" ? "Your key" : "Shared default"}</td>
                  <td>{r.calls}</td><td>{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</td><td>{r.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
