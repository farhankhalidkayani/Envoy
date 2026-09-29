"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  resolveVisibility,
  validateFields,
  type FormOption,
  type PublicFormField,
  type PublicFormSchema,
} from "@envoy/types";

export type SubmitResult = { ok: true; successMessage: string } | { ok: false; errors?: Record<string, string>; message?: string };

interface Props {
  schema: PublicFormSchema;
  loadOptions(fieldKey: string, answers: Record<string, unknown>): Promise<FormOption[]>;
  onSubmit(values: Record<string, unknown>): Promise<SubmitResult>;
  /** Accent color for buttons/progress. */
  accent?: string;
}

type OptionsState = { status: "loading" } | { status: "ready"; options: FormOption[] } | { status: "error"; message: string };

/**
 * Multi-step, conditional renderer. Visibility and per-step validation use
 * the same @envoy/types functions the server runs on submit, so what the
 * visitor sees hidden is exactly what the server ignores.
 */
export function FormRenderer({ schema, loadOptions, onSubmit, accent }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [apiOptions, setApiOptions] = useState<Record<string, OptionsState>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);

  const visibility = useMemo(() => resolveVisibility(schema, values), [schema, values]);
  // A step whose fields are all hidden is skipped — never show an empty page.
  const steps = schema.steps.filter(
    (s) => visibility.visibleStepIds.has(s.id) && s.fields.some((f) => visibility.visibleFieldIds.has(f.id)),
  );
  const index = Math.min(stepIndex, Math.max(steps.length - 1, 0));
  const step = steps[index];
  const fields = step?.fields.filter((f) => visibility.visibleFieldIds.has(f.id)) ?? [];
  const isLast = index >= steps.length - 1;

  // API-sourced dropdowns: (re)load whenever the answers they depend on change.
  const apiFields = fields.filter((f) => f.apiOptions);
  const depSignature = JSON.stringify(apiFields.map((f) => [f.key, f.apiOptions!.dependsOn.map((k) => values[k] ?? null)]));
  useEffect(() => {
    let cancelled = false;
    for (const field of apiFields) {
      const deps = field.apiOptions!.dependsOn;
      if (deps.some((k) => values[k] === undefined || values[k] === "")) {
        setApiOptions((prev) => ({ ...prev, [field.key]: { status: "ready", options: [] } }));
        continue;
      }
      const answers = Object.fromEntries(deps.map((k) => [k, values[k]]));
      setApiOptions((prev) => ({ ...prev, [field.key]: { status: "loading" } }));
      loadOptions(field.key, answers)
        .then((options) => {
          if (cancelled) return;
          setApiOptions((prev) => ({ ...prev, [field.key]: { status: "ready", options } }));
          // A dependent answer that no longer exists in the new list is stale.
          setValues((prev) =>
            prev[field.key] !== undefined && !options.some((o) => o.value === prev[field.key])
              ? { ...prev, [field.key]: "" }
              : prev,
          );
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setApiOptions((prev) => ({
            ...prev,
            [field.key]: { status: "error", message: err instanceof Error ? err.message : "Could not load options" },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depSignature, step?.id]);

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function goTo(i: number) {
    setStepIndex(i);
    setFormError(null);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function next(e: React.FormEvent) {
    e.preventDefault();
    const result = validateFields(fields, values);
    if (!result.valid) {
      setErrors(result.errors);
      document.getElementById(`ef-${Object.keys(result.errors)[0]}`)?.focus();
      return;
    }
    if (!isLast) return goTo(index + 1);

    setSubmitting(true);
    setFormError(null);
    const outcome = await onSubmit(visibility.data);
    setSubmitting(false);
    if (outcome.ok) {
      setDone(outcome.successMessage);
      return;
    }
    if (outcome.errors && Object.keys(outcome.errors).length) {
      setErrors(outcome.errors);
      const firstBad = steps.findIndex((s) => s.fields.some((f) => outcome.errors![f.key]));
      if (firstBad !== -1 && firstBad !== index) goTo(firstBad);
    }
    setFormError(outcome.message ?? "Please fix the highlighted fields.");
  }

  const style = accent ? ({ "--ef-accent": accent } as React.CSSProperties) : undefined;

  if (done) {
    return (
      <div className="ef-root" style={style}>
        <div className="ef-done" role="status">
          <div className="ef-done-icon" aria-hidden>✓</div>
          <p>{done}</p>
        </div>
      </div>
    );
  }

  if (!step) {
    return (
      <div className="ef-root" style={style}>
        <p className="ef-muted">This form has no fields yet.</p>
      </div>
    );
  }

  return (
    <form className="ef-root" style={style} onSubmit={next} noValidate>
      {steps.length > 1 && (
        <div className="ef-progress" aria-hidden>
          <div className="ef-progress-bar" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
      )}
      <div className="ef-step-meta">
        {steps.length > 1 && <span className="ef-muted">Step {index + 1} of {steps.length}</span>}
        {step.title && (
          <h2 className="ef-step-title" tabIndex={-1} ref={headingRef}>
            {step.title}
          </h2>
        )}
      </div>

      {fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.key]}
          error={errors[field.key]}
          options={field.apiOptions ? apiOptions[field.key] : { status: "ready", options: field.options ?? [] }}
          waitingOn={field.apiOptions?.dependsOn.filter((k) => values[k] === undefined || values[k] === "") ?? []}
          onChange={(v) => setValue(field.key, v)}
        />
      ))}

      {formError && (
        <div className="ef-form-error" role="alert">
          {formError}
        </div>
      )}

      <div className="ef-actions">
        {index > 0 && (
          <button type="button" className="ef-btn ef-btn-secondary" onClick={() => goTo(index - 1)}>
            Back
          </button>
        )}
        <button type="submit" className="ef-btn ef-btn-primary" disabled={submitting}>
          {submitting ? "Sending…" : isLast ? schema.submitLabel : "Next"}
        </button>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  options,
  waitingOn,
  onChange,
}: {
  field: PublicFormField;
  value: unknown;
  error?: string;
  options?: OptionsState;
  waitingOn: string[];
  onChange(value: unknown): void;
}) {
  const id = `ef-${field.key}`;
  const describedBy = [field.helpText ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name: field.key,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  };
  const str = value === undefined || value === null ? "" : String(value);

  let control: React.ReactNode;
  switch (field.type) {
    case "textarea":
      control = <textarea {...common} rows={4} placeholder={field.placeholder} value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "checkbox":
      return (
        <div className="ef-field">
          <label className="ef-check">
            <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span>
              {field.label}
              {field.required && <span className="ef-req" aria-hidden> *</span>}
            </span>
          </label>
          {field.helpText && <div id={`${id}-help`} className="ef-help">{field.helpText}</div>}
          {error && <div id={`${id}-error`} className="ef-error">{error}</div>}
        </div>
      );
    case "select":
    case "radio": {
      const state = options ?? { status: "loading" as const };
      if (waitingOn.length) {
        control = <div className="ef-muted ef-placeholder">Answer the question{waitingOn.length > 1 ? "s" : ""} above first.</div>;
      } else if (state.status === "loading") {
        control = <div className="ef-muted ef-placeholder">Loading options…</div>;
      } else if (state.status === "error") {
        control = <div className="ef-error">{state.message}</div>;
      } else if (field.type === "select") {
        control = (
          <select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">{field.placeholder || "Select…"}</option>
            {state.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      } else {
        return (
          <fieldset className="ef-field ef-fieldset" aria-describedby={describedBy} aria-invalid={error ? true : undefined}>
            <legend className="ef-label">
              {field.label}
              {field.required && <span className="ef-req" aria-hidden> *</span>}
            </legend>
            {state.options.map((o, i) => (
              <label key={o.value} className="ef-check">
                <input
                  type="radio"
                  id={i === 0 ? id : undefined}
                  name={field.key}
                  value={o.value}
                  checked={str === o.value}
                  onChange={() => onChange(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
            {field.helpText && <div id={`${id}-help`} className="ef-help">{field.helpText}</div>}
            {error && <div id={`${id}-error`} className="ef-error">{error}</div>}
          </fieldset>
        );
      }
      break;
    }
    default: {
      const type = { email: "email", phone: "tel", number: "number", date: "date" }[field.type as string] ?? "text";
      control = (
        <input
          {...common}
          type={type}
          inputMode={field.type === "number" ? "decimal" : undefined}
          autoComplete={field.type === "email" ? "email" : field.type === "phone" ? "tel" : undefined}
          placeholder={field.placeholder}
          value={str}
          onChange={(e) => onChange(field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
        />
      );
    }
  }

  return (
    <div className="ef-field">
      <label className="ef-label" htmlFor={id}>
        {field.label}
        {field.required && <span className="ef-req" aria-hidden> *</span>}
      </label>
      {control}
      {field.helpText && <div id={`${id}-help`} className="ef-help">{field.helpText}</div>}
      {error && <div id={`${id}-error`} className="ef-error">{error}</div>}
    </div>
  );
}
