"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Form, FormSubmission } from "@envoy/sdk";
import { toPublicFormSchema, validateSubmission, type FormField, type FormSchema, type FormStep } from "@envoy/types";
import { BlockBuilder } from "@envoy/builder";
import "@envoy/builder/builder.css";
import { api } from "../../../../lib/api";
import { errorMessage } from "../../../../lib/errors";
import {
  fieldPalette,
  FIELD_TYPE_LABELS,
  cloneField,
  formAdapter,
  isChoice,
  newStep,
  schemaIssues,
} from "../../../../lib/forms";
import { useToast } from "../../../../components/Toast";
import { ConfirmDialog } from "../../../../components/ConfirmDialog";
import { FormRenderer } from "../../../../components/forms/FormRenderer";
import { FieldInspector, FormSettings, StepInspector } from "../../../../components/forms/FormInspector";

type Tab = "build" | "preview" | "submissions" | "share";

export default function FormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { showToast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("build");
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  useEffect(() => {
    api.forms
      .get(id)
      .then((f) => {
        setForm(f);
        setSchema(f.schema);
        setName(f.name);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  const issues = useMemo(() => (schema ? schemaIssues(schema) : { byId: {}, messages: [] }), [schema]);

  const edit = useCallback((update: (s: FormSchema) => FormSchema) => {
    setSchema((s) => (s ? update(s) : s));
    setDirty(true);
  }, []);

  const save = useCallback(
    async (status?: Form["status"]) => {
      if (!schema || !form) return;
      if (issues.messages.length) {
        setError(`Fix ${issues.messages.length} issue${issues.messages.length > 1 ? "s" : ""} before saving: ${issues.messages[0]}`);
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const updated = await api.forms.update(form.id, { name, schema, ...(status ? { status } : {}) });
        setForm(updated);
        setDirty(false);
        showToast(status === "live" ? "Form published." : status === "draft" ? "Form unpublished." : "Form saved.");
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [schema, form, name, issues, showToast],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!form || !schema) {
    return error ? (
      <div>
        <div className="error-banner">{error}</div>
        <Link href="/dashboard/forms" className="btn">
          ← Back to forms
        </Link>
      </div>
    ) : (
      <div className="card">Loading form…</div>
    );
  }

  return (
    <div className="fb-page">
      <div className="fb-header">
        <div className="fb-title">
          <Link href="/dashboard/forms" className="fb-back" aria-label="Back to forms">
            ←
          </Link>
          <input
            className="fb-name"
            aria-label="Form name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
          <span className={`pill ${form.status === "live" ? "pill-ok" : "pill-gray"}`}>{form.status}</span>
          {dirty && <span className="fb-dirty">Unsaved changes</span>}
        </div>
        <div className="fb-actions">
          <button className="btn" onClick={() => save()} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save"}
          </button>
          {form.status === "live" ? (
            <button className="btn" onClick={() => setConfirmUnpublish(true)} disabled={saving}>
              Unpublish
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => save("live")} disabled={saving}>
              Publish
            </button>
          )}
        </div>
      </div>

      <div className="fb-tabs" role="tablist" aria-label="Form views">
        {(["build", "preview", "submissions", "share"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`fb-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {tab === "build" && issues.messages.length > 0 && (
        <div className="fb-issues" role="status">
          {issues.messages.length} issue{issues.messages.length > 1 ? "s" : ""} to fix: {issues.messages[0]}
        </div>
      )}

      {tab === "build" && (
        <BlockBuilder<FormStep, FormField>
          adapter={formAdapter}
          containers={schema.steps}
          onChange={(steps) => edit((s) => ({ ...s, steps }))}
          palette={fieldPalette(schema)}
          paletteTitle="Fields"
          containerNoun="step"
          issues={issues.byId}
          createContainer={() => newStep(schema.steps.length + 1)}
          cloneBlock={cloneField}
          blockLabel={(f) => `${f.label} (${FIELD_TYPE_LABELS[f.type]})`}
          renderContainerHeader={(step, i) => (
            <span>
              {step.title || `Step ${i + 1}`}
              {step.visibility && <span className="fb-badge" title="Conditional step">if</span>}
            </span>
          )}
          renderBlock={(f) => <FieldPreview field={f} />}
          renderInspector={(selection, builder) => {
            if (selection?.kind === "block") {
              return (
                <FieldInspector
                  key={selection.block.id}
                  field={selection.block}
                  schema={schema}
                  onChange={(update) => builder.updateBlock(selection.block.id, update)}
                />
              );
            }
            if (selection?.kind === "container") {
              return (
                <StepInspector
                  key={selection.container.id}
                  step={selection.container}
                  index={selection.containerIndex}
                  schema={schema}
                  onChange={(update) => builder.updateContainer(selection.container.id, update)}
                />
              );
            }
            return <FormSettings schema={schema} onChange={edit} />;
          }}
        />
      )}

      {tab === "preview" && <PreviewPane schema={schema} />}
      {tab === "submissions" && <SubmissionsPane form={form} schema={schema} />}
      {tab === "share" && <SharePane form={form} />}

      <ConfirmDialog
        open={confirmUnpublish}
        title="Unpublish this form?"
        description="The public link and any embeds will stop working until you publish again. Existing submissions are kept."
        confirmLabel="Unpublish"
        danger
        busy={saving}
        onConfirm={() => {
          setConfirmUnpublish(false);
          void save("draft");
        }}
        onCancel={() => setConfirmUnpublish(false)}
      />
    </div>
  );
}

function FieldPreview({ field }: { field: FormField }) {
  return (
    <div className="fb-field-preview">
      <div className="fb-field-label">
        {field.label}
        {field.required && <span className="ef-req"> *</span>}
      </div>
      <div className="fb-field-meta">
        <span>{FIELD_TYPE_LABELS[field.type]}</span>
        <code>{field.key}</code>
        {field.visibility && <span className="fb-badge" title="Only shown when its conditions match">if</span>}
        {field.optionsSource && <span className="fb-badge" title="Options loaded from an API">API</span>}
        {isChoice(field.type) && !field.optionsSource && (
          <span>{field.options?.length ?? 0} options</span>
        )}
      </div>
    </div>
  );
}

function PreviewPane({ schema }: { schema: FormSchema }) {
  const publicSchema = useMemo(() => toPublicFormSchema(schema), [schema]);
  // Remount on schema change so the preview starts from step 1 after edits.
  const [nonce, setNonce] = useState(0);
  return (
    <div className="fb-preview">
      <div className="fb-preview-bar">
        <span>Preview — submissions here are validated but not saved. API dropdowns use your unsaved settings.</span>
        <button className="btn fi-small-btn" onClick={() => setNonce((n) => n + 1)}>
          Restart
        </button>
      </div>
      <div className="fb-preview-frame">
        <FormRenderer
          key={nonce}
          schema={publicSchema}
          loadOptions={async (fieldKey, answers) => {
            const source = schema.steps.flatMap((s) => s.fields).find((f) => f.key === fieldKey)?.optionsSource;
            if (!source) return [];
            try {
              return await api.forms.testOptions(source, answers);
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
          onSubmit={async (values) => {
            const result = validateSubmission(schema, values);
            return result.valid
              ? { ok: true, successMessage: schema.successMessage }
              : { ok: false, errors: result.errors };
          }}
        />
      </div>
    </div>
  );
}

const DESTINATIONS = ["webhook", "email", "calendar"] as const;

function SubmissionsPane({ form, schema }: { form: Form; schema: FormSchema }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<FormSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const load = useCallback(() => {
    api.forms.submissions(form.id).then(setRows).catch((err) => setError(errorMessage(err)));
  }, [form.id]);
  useEffect(load, [load]);

  const fields = schema.steps.flatMap((s) => s.fields);
  // Include keys from older submissions whose fields were since removed.
  const extraKeys = [...new Set((rows ?? []).flatMap((r) => Object.keys(r.data)))].filter(
    (k) => !fields.some((f) => f.key === k),
  );
  const columns = [...fields.map((f) => ({ key: f.key, label: f.label })), ...extraKeys.map((k) => ({ key: k, label: k }))];

  async function retry(row: FormSubmission, dest: "crm" | (typeof DESTINATIONS)[number]) {
    setRetrying(`${row.id}:${dest}`);
    try {
      const result = dest === "crm" ? await api.crm.pushSubmission(row.id) : await api.integrations.pushSubmission(dest, row.id);
      if (!result.success) throw new Error(result.error ?? "Push failed");
      showToast("Re-sent.");
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(null);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <div className="card">Loading submissions…</div>;
  if (!rows.length) {
    return (
      <div className="card" style={{ color: "var(--ink-faint)" }}>
        No submissions yet.{form.status !== "live" && " Publish the form and share its link to start collecting leads."}
      </div>
    );
  }

  return (
    <div className="card fb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th>Delivered to</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const statuses: Array<{ dest: "crm" | (typeof DESTINATIONS)[number]; ok: boolean; error?: string }> = [];
            if (row.crmPushedAt || row.crmPushError) statuses.push({ dest: "crm", ok: !!row.crmPushedAt, error: row.crmPushError ?? undefined });
            for (const d of DESTINATIONS) {
              const s = row.integrationStatus[d];
              if (s) statuses.push({ dest: d, ok: !!s.pushedAt, error: s.error });
            }
            return (
              <tr key={row.id}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(row.createdAt).toLocaleString()}</td>
                {columns.map((c) => (
                  <td key={c.key}>{row.data[c.key] === undefined ? "—" : String(row.data[c.key])}</td>
                ))}
                <td>
                  {statuses.length === 0 && <span className="fb-muted">No destinations connected</span>}
                  {statuses.map((s) =>
                    s.ok ? (
                      <span key={s.dest} className="pill pill-ok" style={{ marginRight: 4 }}>
                        {s.dest}
                      </span>
                    ) : (
                      <button
                        key={s.dest}
                        className="pill pill-stop fb-retry"
                        title={`${s.error ?? "Failed"} — click to retry`}
                        disabled={retrying === `${row.id}:${s.dest}`}
                        onClick={() => retry(row, s.dest)}
                      >
                        {s.dest} ↻
                      </button>
                    ),
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SharePane({ form }: { form: Form }) {
  const { showToast } = useToast();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/f/${form.publicToken}`;
  const embed = `<iframe src="${url}?embed=1" title="${form.name.replace(/"/g, "&quot;")}" style="width:100%;border:0;min-height:420px" id="envoy-form-${form.publicToken}"></iframe>
<script>
  window.addEventListener("message", function (e) {
    if (e.origin !== "${origin}" || !e.data || e.data.type !== "envoy-form:height") return;
    document.getElementById("envoy-form-${form.publicToken}").style.height = e.data.height + "px";
  });
</script>`;

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied.`);
  }

  return (
    <div style={{ maxWidth: 760 }}>
      {form.status !== "live" && (
        <div className="fb-issues">This form is a draft — the link and embed show “not found” until you publish.</div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ display: "block", marginBottom: 8, fontSize: 13.5 }}>Public link</strong>
        <div className="fb-copy-row">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Public link" />
          <button className="btn" onClick={() => copy(url, "Link")}>
            Copy
          </button>
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </div>
      <div className="card">
        <strong style={{ display: "block", marginBottom: 4, fontSize: 13.5 }}>Embed on your site</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 10 }}>
          Paste this where the form should appear. It resizes itself to fit each step.
        </p>
        <textarea readOnly rows={9} value={embed} className="fb-code" aria-label="Embed code" onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" style={{ marginTop: 8 }} onClick={() => copy(embed, "Embed code")}>
          Copy embed code
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginTop: 12 }}>
        Submissions go wherever you&apos;ve connected captured data — <Link href="/dashboard/crm">CRM</Link> and{" "}
        <Link href="/dashboard/integrations">integrations</Link> — using each field&apos;s key.
      </p>
    </div>
  );
}
