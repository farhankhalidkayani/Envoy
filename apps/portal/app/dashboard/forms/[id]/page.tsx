"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  // Persists across React StrictMode's dev-only double-invoke of this effect
  // (mount → cleanup → mount) — a ref, unlike a local `cancelled` flag, is
  // shared by both invocations, so this guarantees exactly one fetch and one
  // application of its result no matter how many times the effect body
  // itself runs. Without it, a second fetch's result can land after the
  // user has already started editing and silently overwrite their changes
  // — worse here than a plain read-only page, since autosave (below) would
  // then write that stale, clobbered state straight back to the server.
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (fetchedRef.current === id) return;
    fetchedRef.current = id;

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
    async (status?: Form["status"], opts: { silent?: boolean } = {}) => {
      if (!schema || !form) return;
      if (issues.messages.length) {
        // Autosave stays quiet about invalid schemas — the "issues to fix" banner
        // above the canvas already says so; a manual Save click still reports it.
        if (!opts.silent) {
          setError(`Fix ${issues.messages.length} issue${issues.messages.length > 1 ? "s" : ""} before saving: ${issues.messages[0]}`);
        }
        return;
      }
      setSaving(true);
      if (!opts.silent) setError(null);
      try {
        const updated = await api.forms.update(form.id, { name, schema, ...(status ? { status } : {}) });
        setForm(updated);
        setDirty(false);
        if (!opts.silent) {
          showToast(status === "live" ? "Form published." : status === "draft" ? "Form unpublished." : "Form saved.");
        }
      } catch (err) {
        if (!opts.silent) setError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [schema, form, name, issues, showToast],
  );

  // Autosave: 2s after the last edit, once the schema is valid. Manual Save
  // (button or Cmd+S) still exists for "save right now, don't wait."
  useEffect(() => {
    if (!dirty || issues.messages.length) return;
    const t = setTimeout(() => void save(undefined, { silent: true }), 2000);
    return () => clearTimeout(t);
  }, [dirty, schema, name, issues, save]);

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
          <span className={`fb-dirty${dirty || saving ? "" : " fb-dirty-saved"}`} role="status">
            {saving ? "Saving…" : dirty ? "Unsaved changes — autosaving…" : "Saved"}
          </span>
        </div>
        <div className="fb-actions">
          <button className="btn" onClick={() => save()} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save now"}
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
          accent={schema.accentColor}
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
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState<FormSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const load = useCallback(() => {
    api.forms
      .submissions(form.id)
      .then((page) => {
        setRows(page.rows);
        setNextCursor(page.nextCursor);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [form.id]);
  useEffect(load, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.forms.submissions(form.id, { cursor: nextCursor });
      setRows((prev) => [...(prev ?? []), ...page.rows]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await api.forms.exportSubmissionsCsv(form.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${form.name.replace(/[^\w-]+/g, "_") || "submissions"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.forms.deleteSubmission(form.id, deleting.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== deleting.id));
      setDeleting(null);
      showToast("Submission deleted.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="btn" onClick={exportCsv} disabled={exporting}>
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <div className="card fb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th>Delivered to</th>
            <th aria-label="Actions" />
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
                <td>
                  <button className="eb-icon-btn" aria-label="Delete submission" onClick={() => setDeleting(row)}>
                    🗑
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {nextCursor && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this submission?"
        description="This permanently removes the submission and its captured data. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
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
