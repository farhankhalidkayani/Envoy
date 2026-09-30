"use client";

import { useState } from "react";
import {
  optionsUrlDependencies,
  type ApiOptionsSource,
  type ConditionOp,
  type FormCondition,
  type FormField,
  type FormFieldType,
  type FormOption,
  type FormSchema,
  type FormStep,
  type VisibilityRule,
} from "@envoy/types";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { FIELD_TYPE_LABELS, earlierFields, isChoice, keyFromLabel, optionFromLabel, uniqueKey } from "../../lib/forms";

const OP_LABELS: Record<ConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  is_empty: "is empty",
  is_not_empty: "is answered",
};
const VALUELESS_OPS: ConditionOp[] = ["is_empty", "is_not_empty"];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fi-row">
      <span className="fi-label">{label}</span>
      {children}
      {hint && <span className="fi-hint">{hint}</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fi-section">
      <div className="fi-section-title">{title}</div>
      {children}
    </div>
  );
}

function numOrUndef(v: string): number | undefined {
  return v === "" || Number.isNaN(Number(v)) ? undefined : Number(v);
}

export function FieldInspector({
  field,
  schema,
  onChange,
}: {
  field: FormField;
  schema: FormSchema;
  onChange(update: (f: FormField) => FormField): void;
}) {
  const otherKeys = new Set(schema.steps.flatMap((s) => s.fields).filter((f) => f.id !== field.id).map((f) => f.key));
  const set = (patch: Partial<FormField>) => onChange((f) => ({ ...f, ...patch }));
  const choice = isChoice(field.type);
  const earlier = earlierFields(schema, { fieldId: field.id });

  function setLabel(label: string) {
    // Keep the key following the label until the tenant edits the key by hand.
    const autoKey = field.key.startsWith("field_") || field.key === uniqueKey(keyFromLabel(field.label), otherKeys);
    set({ label, ...(autoKey && label.trim() ? { key: uniqueKey(keyFromLabel(label), otherKeys) } : {}) });
  }

  function setType(type: FormFieldType) {
    onChange((f) => {
      const next: FormField = { ...f, type };
      if (isChoice(type) && !f.options?.length && !f.optionsSource) {
        next.options = [optionFromLabel("Option 1")];
      }
      if (!isChoice(type)) {
        delete next.options;
        delete next.optionsSource;
      }
      if (type === "content" && !f.content) next.content = "Add your text here.";
      if (type !== "content") delete next.content;
      if (type === "hidden" && !f.hiddenSource) next.hiddenSource = { queryParam: "utm_source" };
      if (type !== "hidden") delete next.hiddenSource;
      if (type !== "file") {
        delete next.fileAccept;
        delete next.fileMaxSizeKb;
      }
      return next;
    });
  }

  const isPlainInput = !["checkbox", "radio", "multiselect", "content", "file", "hidden"].includes(field.type);

  return (
    <div className="fi">
      <div className="eb-pane-title">{FIELD_TYPE_LABELS[field.type]} field</div>
      <Section title="Basics">
        <Row label="Label">
          <input value={field.label} onChange={(e) => setLabel(e.target.value)} />
        </Row>
        <Row label="Field key" hint="Name this answer uses in CRM, webhook, email and calendar data.">
          <input value={field.key} onChange={(e) => set({ key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} />
        </Row>
        <Row label="Type">
          <select value={field.type} onChange={(e) => setType(e.target.value as FormFieldType)}>
            {Object.entries(FIELD_TYPE_LABELS).map(([t, l]) => (
              <option key={t} value={t}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        {(isPlainInput || field.type === "file") && (
          <Row label="Placeholder">
            <input value={field.placeholder ?? ""} onChange={(e) => set({ placeholder: e.target.value || undefined })} />
          </Row>
        )}
        {field.type !== "content" && field.type !== "hidden" && (
          <Row label="Help text">
            <input value={field.helpText ?? ""} onChange={(e) => set({ helpText: e.target.value || undefined })} />
          </Row>
        )}
        {field.type !== "content" && (
          <label className="fi-toggle">
            <input type="checkbox" checked={field.required} onChange={(e) => set({ required: e.target.checked })} />
            <span>{field.type === "checkbox" ? "Must be checked" : "Required"}</span>
          </label>
        )}
      </Section>

      {field.type === "content" && (
        <Section title="Content">
          <Row label="Text" hint="Shown as a heading/paragraph in place of an input — supports plain text only.">
            <textarea rows={4} value={field.content ?? ""} onChange={(e) => set({ content: e.target.value })} />
          </Row>
        </Section>
      )}

      {field.type === "file" && (
        <Section title="File">
          <Row label="Accepted types" hint='e.g. "image/*,.pdf" — comma-separated MIME types or extensions.'>
            <input value={field.fileAccept ?? ""} onChange={(e) => set({ fileAccept: e.target.value || undefined })} />
          </Row>
          <Row label="Max size (KB)" hint="Up to 1536 KB (~1.5MB).">
            <input
              type="number"
              min={1}
              max={1536}
              value={field.fileMaxSizeKb ?? ""}
              onChange={(e) => set({ fileMaxSizeKb: numOrUndef(e.target.value) })}
            />
          </Row>
        </Section>
      )}

      {field.type === "hidden" && (
        <Section title="Value source">
          <Row label="URL query parameter" hint="e.g. utm_source — read from the page's URL when the form loads.">
            <input
              value={field.hiddenSource?.queryParam ?? ""}
              onChange={(e) => set({ hiddenSource: { ...field.hiddenSource, queryParam: e.target.value || undefined } })}
            />
          </Row>
          <Row label="Default value" hint="Used when the query parameter isn't present.">
            <input
              value={field.hiddenSource?.defaultValue ?? ""}
              onChange={(e) => set({ hiddenSource: { ...field.hiddenSource, defaultValue: e.target.value || undefined } })}
            />
          </Row>
        </Section>
      )}

      {choice && (
        <Section title="Options">
          <div className="fi-segment" role="radiogroup" aria-label="Options source">
            <button
              type="button"
              role="radio"
              aria-checked={!field.optionsSource}
              className={!field.optionsSource ? "active" : ""}
              onClick={() =>
                onChange((f) => {
                  const { optionsSource: _drop, ...rest } = f;
                  return { ...rest, options: f.options?.length ? f.options : [optionFromLabel("Option 1")] };
                })
              }
            >
              Fixed list
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!!field.optionsSource}
              className={field.optionsSource ? "active" : ""}
              onClick={() =>
                set({ optionsSource: field.optionsSource ?? { url: "https://", itemsPath: "", labelKey: "name", valueKey: "id" } })
              }
            >
              From an API
            </button>
          </div>
          {field.optionsSource ? (
            <ApiSourceEditor
              source={field.optionsSource}
              earlierKeys={earlier.map((f) => f.key)}
              onChange={(optionsSource) => set({ optionsSource })}
            />
          ) : (
            <StaticOptionsEditor options={field.options ?? []} onChange={(options) => set({ options })} />
          )}
        </Section>
      )}

      {(field.type === "text" || field.type === "textarea" || field.type === "number") && (
        <Section title="Validation">
          <div className="fi-grid2">
            <Row label={field.type === "number" ? "Min value" : "Min length"}>
              <input
                type="number"
                value={field.validation?.min ?? ""}
                onChange={(e) => set({ validation: { ...field.validation, min: numOrUndef(e.target.value) } })}
              />
            </Row>
            <Row label={field.type === "number" ? "Max value" : "Max length"}>
              <input
                type="number"
                value={field.validation?.max ?? ""}
                onChange={(e) => set({ validation: { ...field.validation, max: numOrUndef(e.target.value) } })}
              />
            </Row>
          </div>
          {field.type !== "number" && (
            <>
              <Row label="Pattern (regex)" hint="e.g. ^[A-Z]{2}\d{4}$">
                <input
                  value={field.validation?.pattern ?? ""}
                  onChange={(e) => set({ validation: { ...field.validation, pattern: e.target.value || undefined } })}
                />
              </Row>
              {field.validation?.pattern && (
                <Row label="Message when pattern fails">
                  <input
                    value={field.validation?.patternMessage ?? ""}
                    onChange={(e) =>
                      set({ validation: { ...field.validation, patternMessage: e.target.value || undefined } })
                    }
                  />
                </Row>
              )}
            </>
          )}
        </Section>
      )}

      <Section title="Show this field">
        <ConditionEditor rule={field.visibility} fields={earlier} onChange={(visibility) => set({ visibility })} />
      </Section>
    </div>
  );
}

export function StepInspector({
  step,
  schema,
  index,
  onChange,
}: {
  step: FormStep;
  schema: FormSchema;
  index: number;
  onChange(update: (s: FormStep) => FormStep): void;
}) {
  return (
    <div className="fi">
      <div className="eb-pane-title">Step {index + 1}</div>
      <Section title="Basics">
        <Row label="Title" hint="Shown above this step's fields.">
          <input value={step.title ?? ""} onChange={(e) => onChange((s) => ({ ...s, title: e.target.value || undefined }))} />
        </Row>
      </Section>
      <Section title="Show this step">
        <ConditionEditor
          rule={step.visibility}
          fields={earlierFields(schema, { stepId: step.id })}
          onChange={(visibility) => onChange((s) => ({ ...s, visibility }))}
        />
      </Section>
    </div>
  );
}

export function FormSettings({
  schema,
  onChange,
}: {
  schema: FormSchema;
  onChange(update: (s: FormSchema) => FormSchema): void;
}) {
  return (
    <div className="fi">
      <div className="eb-pane-title">Form settings</div>
      <p className="fi-hint" style={{ marginBottom: 12 }}>
        Select a field or step on the canvas to edit it. Drag blocks from the left to add fields.
      </p>
      <Section title="Submission">
        <Row label="Submit button label">
          <input value={schema.submitLabel} onChange={(e) => onChange((s) => ({ ...s, submitLabel: e.target.value }))} />
        </Row>
        <Row label="Success message">
          <textarea
            rows={3}
            value={schema.successMessage}
            onChange={(e) => onChange((s) => ({ ...s, successMessage: e.target.value }))}
          />
        </Row>
      </Section>
    </div>
  );
}

function ConditionEditor({
  rule,
  fields,
  onChange,
}: {
  rule?: VisibilityRule;
  fields: FormField[];
  onChange(rule: VisibilityRule | undefined): void;
}) {
  if (!fields.length) {
    return <p className="fi-hint">Always shown. Conditions can only use questions that come earlier in the form.</p>;
  }
  const conditions = rule?.conditions ?? [];
  const update = (next: FormCondition[], match = rule?.match ?? "all") =>
    onChange(next.length ? { match, conditions: next } : undefined);

  return (
    <div>
      {!conditions.length ? (
        <p className="fi-hint">Always shown.</p>
      ) : (
        <div className="fi-match">
          Show when{" "}
          <select
            aria-label="Match"
            value={rule?.match ?? "all"}
            onChange={(e) => update(conditions, e.target.value as "all" | "any")}
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>{" "}
          of these are true:
        </div>
      )}
      {conditions.map((c, i) => {
        const source = fields.find((f) => f.key === c.fieldKey);
        const setC = (patch: Partial<FormCondition>) => update(conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="fi-condition">
            <select aria-label="Question" value={c.fieldKey} onChange={(e) => setC({ fieldKey: e.target.value, value: "" })}>
              {!source && <option value={c.fieldKey}>(missing: {c.fieldKey})</option>}
              {fields.map((f) => (
                <option key={f.id} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select aria-label="Operator" value={c.op} onChange={(e) => setC({ op: e.target.value as ConditionOp })}>
              {(Object.keys(OP_LABELS) as ConditionOp[])
                .filter((op) => (op === "gt" || op === "lt" ? source?.type === "number" : true))
                .map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
            </select>
            {!VALUELESS_OPS.includes(c.op) && (
              <ConditionValue field={source} value={c.value} onChange={(value) => setC({ value })} />
            )}
            <button
              type="button"
              className="eb-icon-btn"
              aria-label="Remove condition"
              onClick={() => update(conditions.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn fi-small-btn"
        onClick={() => update([...conditions, { fieldKey: fields[fields.length - 1]!.key, op: "equals", value: "" }])}
      >
        + Add condition
      </button>
    </div>
  );
}

function ConditionValue({
  field,
  value,
  onChange,
}: {
  field?: FormField;
  value: FormCondition["value"];
  onChange(v: FormCondition["value"]): void;
}) {
  if (field?.type === "checkbox") {
    return (
      <select aria-label="Value" value={String(value ?? "true")} onChange={(e) => onChange(e.target.value)}>
        <option value="true">checked</option>
        <option value="false">unchecked</option>
      </select>
    );
  }
  if (field && isChoice(field.type) && !field.optionsSource) {
    return (
      <select aria-label="Value" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label="Value"
      type={field?.type === "number" ? "number" : "text"}
      placeholder={field?.optionsSource ? "option value" : "value"}
      value={String(value ?? "")}
      onChange={(e) => onChange(field?.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
    />
  );
}

function StaticOptionsEditor({ options, onChange }: { options: FormOption[]; onChange(o: FormOption[]): void }) {
  const [showValues, setShowValues] = useState(options.some((o) => o.value !== keyFromLabel(o.label)));
  const setAt = (i: number, patch: Partial<FormOption>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, d: number) => {
    const next = options.slice();
    const [o] = next.splice(i, 1);
    next.splice(i + d, 0, o!);
    onChange(next);
  };
  return (
    <div>
      {options.map((o, i) => (
        <div key={i} className="fi-option">
          <input
            aria-label={`Option ${i + 1} label`}
            value={o.label}
            onChange={(e) =>
              setAt(i, showValues ? { label: e.target.value } : { label: e.target.value, value: keyFromLabel(e.target.value) })
            }
          />
          {showValues && (
            <input aria-label={`Option ${i + 1} value`} value={o.value} onChange={(e) => setAt(i, { value: e.target.value })} />
          )}
          <button type="button" className="eb-icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </button>
          <button
            type="button"
            className="eb-icon-btn"
            aria-label="Move down"
            disabled={i === options.length - 1}
            onClick={() => move(i, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="eb-icon-btn"
            aria-label="Remove option"
            disabled={options.length === 1}
            onClick={() => onChange(options.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="fi-inline">
        <button
          type="button"
          className="btn fi-small-btn"
          onClick={() => onChange([...options, optionFromLabel(`Option ${options.length + 1}`)])}
        >
          + Add option
        </button>
        <label className="fi-toggle">
          <input type="checkbox" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} />
          <span>Custom values</span>
        </label>
      </div>
    </div>
  );
}

function ApiSourceEditor({
  source,
  earlierKeys,
  onChange,
}: {
  source: ApiOptionsSource;
  earlierKeys: string[];
  onChange(s: ApiOptionsSource): void;
}) {
  const [test, setTest] = useState<{ status: "idle" } | { status: "loading" } | { status: "ok"; options: FormOption[] } | { status: "error"; message: string }>({ status: "idle" });
  const [sample, setSample] = useState<Record<string, string>>({});
  const set = (patch: Partial<ApiOptionsSource>) => onChange({ ...source, ...patch });
  const deps = optionsUrlDependencies(source.url);
  const unknownDeps = deps.filter((d) => !earlierKeys.includes(d));
  const headers = Object.entries(source.headers ?? {});

  async function runTest() {
    setTest({ status: "loading" });
    try {
      setTest({ status: "ok", options: await api.forms.testOptions(source, sample) });
    } catch (err) {
      setTest({ status: "error", message: errorMessage(err) });
    }
  }

  return (
    <div>
      <Row label="URL" hint="GET request, made by our server. Use {{fieldKey}} to insert an earlier answer.">
        <input value={source.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} />
      </Row>
      {earlierKeys.length > 0 && (
        <div className="fi-chips" aria-label="Insert an earlier answer">
          {earlierKeys.map((k) => (
            <button key={k} type="button" className="fi-chip" onClick={() => set({ url: `${source.url}{{${k}}}` })}>
              {`{{${k}}}`}
            </button>
          ))}
        </div>
      )}
      {unknownDeps.length > 0 && (
        <p className="fi-warn">Not an earlier field: {unknownDeps.join(", ")}. The dropdown will wait forever.</p>
      )}
      <Row label="List path" hint='Dot path to the array in the JSON, e.g. "data.items". Blank if the response is the array.'>
        <input value={source.itemsPath} onChange={(e) => set({ itemsPath: e.target.value })} spellCheck={false} />
      </Row>
      <div className="fi-grid2">
        <Row label="Label property">
          <input value={source.labelKey} onChange={(e) => set({ labelKey: e.target.value })} spellCheck={false} />
        </Row>
        <Row label="Value property">
          <input value={source.valueKey} onChange={(e) => set({ valueKey: e.target.value })} spellCheck={false} />
        </Row>
      </div>

      <div className="fi-label" style={{ marginTop: 8 }}>
        Headers <span className="fi-hint">(kept server-side, never sent to visitors)</span>
      </div>
      {headers.map(([name, value], i) => (
        <div key={i} className="fi-option">
          <input
            aria-label="Header name"
            placeholder="Authorization"
            value={name}
            onChange={(e) => {
              const next = headers.slice();
              next[i] = [e.target.value, value];
              set({ headers: Object.fromEntries(next) });
            }}
          />
          <input
            aria-label="Header value"
            placeholder="Bearer …"
            value={value}
            onChange={(e) => {
              const next = headers.slice();
              next[i] = [name, e.target.value];
              set({ headers: Object.fromEntries(next) });
            }}
          />
          <button
            type="button"
            className="eb-icon-btn"
            aria-label="Remove header"
            onClick={() => set({ headers: Object.fromEntries(headers.filter((_, j) => j !== i)) })}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn fi-small-btn"
        onClick={() => set({ headers: { ...(source.headers ?? {}), [headers.length ? `X-Header-${headers.length + 1}` : "Authorization"]: "" } })}
      >
        + Add header
      </button>

      <div className="fi-test">
        {deps.map((d) => (
          <Row key={d} label={`Sample value for {{${d}}}`}>
            <input value={sample[d] ?? ""} onChange={(e) => setSample({ ...sample, [d]: e.target.value })} />
          </Row>
        ))}
        <button type="button" className="btn fi-small-btn" onClick={runTest} disabled={test.status === "loading"}>
          {test.status === "loading" ? "Testing…" : "Test request"}
        </button>
        {test.status === "error" && <p className="fi-warn" role="alert">{test.message}</p>}
        {test.status === "ok" && (
          <p className="fi-hint" role="status">
            {test.options.length} option{test.options.length === 1 ? "" : "s"}
            {test.options.length > 0 && `: ${test.options.slice(0, 5).map((o) => o.label).join(", ")}${test.options.length > 5 ? "…" : ""}`}
          </p>
        )}
      </div>
    </div>
  );
}
