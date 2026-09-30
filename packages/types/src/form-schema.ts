import { z } from "zod";

/**
 * Custom lead forms: a tenant-authored, multi-step, conditional form. The
 * schema is the single source of truth for the portal builder, the public
 * renderer, and server-side submission validation — all three call the same
 * functions below so a field the renderer hid is also skipped by the server.
 */

const FieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-zA-Z0-9_]*$/, "key must be a camelCase/snake_case identifier");

export const FormFieldType = z.enum([
  "text",
  "textarea",
  "email",
  "phone",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "multiselect",
  "file",
  "hidden",
  "content",
]);
export type FormFieldType = z.infer<typeof FormFieldType>;

/** Types whose value is picked from `options`/`optionsSource` — single-value. */
export const CHOICE_FIELD_TYPES: readonly FormFieldType[] = ["select", "radio"];
/** Same as CHOICE_FIELD_TYPES, but the value is an array of selections. */
export const MULTI_CHOICE_FIELD_TYPES: readonly FormFieldType[] = ["multiselect"];
/** No visitor input at all: "content" is a static block, "hidden" is populated from the page URL. */
export const NON_INPUT_FIELD_TYPES: readonly FormFieldType[] = ["content", "hidden"];

export const ConditionOp = z.enum(["equals", "not_equals", "contains", "gt", "lt", "is_empty", "is_not_empty"]);
export type ConditionOp = z.infer<typeof ConditionOp>;

export const FormCondition = z.object({
  fieldKey: FieldKey,
  op: ConditionOp,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type FormCondition = z.infer<typeof FormCondition>;

export const VisibilityRule = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(FormCondition).min(1).max(20),
});
export type VisibilityRule = z.infer<typeof VisibilityRule>;

export const FormOption = z.object({ label: z.string().min(1), value: z.string().min(1) });
export type FormOption = z.infer<typeof FormOption>;

/**
 * Dropdown options fetched from a tenant API. `url` may contain `{{fieldKey}}`
 * placeholders (dependent dropdowns, e.g. cities for the chosen country).
 * Fetched server-side through the options proxy, so `headers` (API keys)
 * never reach the browser — the public schema endpoint strips them.
 */
export const ApiOptionsSource = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Dot path to the array in the response, "" when the response IS the array. */
  itemsPath: z.string().default(""),
  labelKey: z.string().min(1),
  valueKey: z.string().min(1),
});
export type ApiOptionsSource = z.infer<typeof ApiOptionsSource>;

const MAX_FILE_SIZE_KB_CAP = 1536; // ~1.5MB raw; base64 transport inflates this ~33% — see main.ts's body-size limit

/** Where a "hidden" field's value comes from: a page URL query param (e.g. utm_source), falling back to a fixed default. */
export const HiddenFieldSource = z.object({
  queryParam: z.string().max(64).optional(),
  defaultValue: z.string().max(500).optional(),
});
export type HiddenFieldSource = z.infer<typeof HiddenFieldSource>;

export const FormField = z
  .object({
    id: z.string().min(1),
    key: FieldKey,
    type: FormFieldType,
    label: z.string().min(1).max(200),
    placeholder: z.string().max(200).optional(),
    helpText: z.string().max(500).optional(),
    required: z.boolean().default(false),
    options: z.array(FormOption).max(500).optional(),
    optionsSource: ApiOptionsSource.optional(),
    visibility: VisibilityRule.optional(),
    validation: z
      .object({
        min: z.number().optional(), // number value, or text length
        max: z.number().optional(),
        pattern: z.string().max(200).optional(),
        patternMessage: z.string().max(200).optional(),
      })
      .optional(),
    /** type === "content": the static text/markdown-lite shown in place of an input. */
    content: z.string().max(5000).optional(),
    /** type === "file": accepted MIME types/extensions (comma-separated, e.g. "image/*,.pdf") and a size cap. */
    fileAccept: z.string().max(200).optional(),
    fileMaxSizeKb: z.number().int().positive().max(MAX_FILE_SIZE_KB_CAP).optional(),
    /** type === "hidden": where the value comes from — never shown or asked. */
    hiddenSource: HiddenFieldSource.optional(),
  })
  .refine(
    (f) => !CHOICE_FIELD_TYPES.includes(f.type) && !MULTI_CHOICE_FIELD_TYPES.includes(f.type)
      || (f.options?.length ?? 0) > 0 || f.optionsSource,
    { message: "choice fields need static options or an API options source", path: ["options"] },
  )
  .refine((f) => f.type !== "content" || !!f.content?.trim(), {
    message: "a content block needs text to display",
    path: ["content"],
  });
export type FormField = z.infer<typeof FormField>;

export const FormStep = z.object({
  id: z.string().min(1),
  title: z.string().max(200).optional(),
  fields: z.array(FormField).max(100),
  visibility: VisibilityRule.optional(),
});
export type FormStep = z.infer<typeof FormStep>;

export const FormSchema = z
  .object({
    steps: z.array(FormStep).min(1).max(20),
    submitLabel: z.string().min(1).max(60).default("Submit"),
    successMessage: z.string().min(1).max(500).default("Thanks! We'll be in touch."),
  })
  .superRefine((schema, ctx) => {
    // Conditions may only reference fields that come EARLIER in the form.
    // That keeps visibility a single forward pass (no cycles, no fixed-point)
    // and matches what a visitor can actually have answered by then.
    const seen = new Set<string>();
    const checkRule = (rule: VisibilityRule | undefined, path: (string | number)[]) => {
      rule?.conditions.forEach((c, i) => {
        if (!seen.has(c.fieldKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `condition references "${c.fieldKey}", which is not an earlier field`,
            path: [...path, "visibility", "conditions", i, "fieldKey"],
          });
        }
      });
    };
    schema.steps.forEach((step, si) => {
      checkRule(step.visibility, ["steps", si]);
      step.fields.forEach((field, fi) => {
        checkRule(field.visibility, ["steps", si, "fields", fi]);
        if (seen.has(field.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate field key "${field.key}"`,
            path: ["steps", si, "fields", fi, "key"],
          });
        }
        seen.add(field.key);
      });
    });
  });
export type FormSchema = z.infer<typeof FormSchema>;

export type FormData = Record<string, unknown>;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

export function evaluateCondition(condition: FormCondition, data: FormData): boolean {
  const actual = data[condition.fieldKey];
  const expected = condition.value;
  switch (condition.op) {
    case "is_empty":
      return isEmpty(actual);
    case "is_not_empty":
      return !isEmpty(actual);
    case "equals":
      return String(actual ?? "") === String(expected ?? "");
    case "not_equals":
      return String(actual ?? "") !== String(expected ?? "");
    case "contains":
      return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "gt":
      return !isEmpty(actual) && Number(actual) > Number(expected);
    case "lt":
      return !isEmpty(actual) && Number(actual) < Number(expected);
  }
}

export function isVisible(rule: VisibilityRule | undefined, data: FormData): boolean {
  if (!rule) return true;
  const results = rule.conditions.map((c) => evaluateCondition(c, data));
  return rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Walks the form in order and returns which steps/fields are visible plus
 * the answers restricted to visible fields. A hidden field's stale answer is
 * dropped before later conditions see it, so hiding field A also correctly
 * hides anything that depended on A's value.
 */
export function resolveVisibility(schema: FormSchema | PublicFormSchema, data: FormData) {
  const effective: FormData = {};
  const visibleStepIds = new Set<string>();
  const visibleFieldIds = new Set<string>();
  for (const step of schema.steps) {
    if (!isVisible(step.visibility, effective)) continue;
    visibleStepIds.add(step.id);
    for (const field of step.fields) {
      if (!isVisible(field.visibility, effective)) continue;
      visibleFieldIds.add(field.id);
      if (!isEmpty(data[field.key])) effective[field.key] = data[field.key];
    }
  }
  return { visibleStepIds, visibleFieldIds, data: effective };
}

// ponytail: tenant-authored regex runs server-side on public input; values
// are length-capped (MAX_TEXT_LENGTH) and patterns capped at 200 chars, but a
// pathological pattern can still backtrack. Move to RE2 if abuse shows up.
const MAX_TEXT_LENGTH = 5000;

type AnyFormField = FormField | PublicFormField;

function hasDynamicOptions(field: AnyFormField): boolean {
  return ("optionsSource" in field && !!field.optionsSource) || ("apiOptions" in field && !!field.apiOptions);
}

/** A data: URL, base64-transported (no multipart) — see FormRenderer's file input handling. */
const FILE_DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s;

function fileMimeAllowed(mime: string, accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.split(",").map((s) => s.trim()).some((pattern) => {
    if (pattern.startsWith(".")) return false; // extension patterns can't be checked from a MIME type alone
    if (pattern.endsWith("/*")) return mime.startsWith(pattern.slice(0, -1));
    return mime === pattern;
  });
}

function validateValue(field: AnyFormField, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const v = field.validation;
  switch (field.type) {
    case "checkbox": {
      const checked = raw === true || raw === "true" || raw === "on";
      if (field.required && !checked) return { ok: false, error: "This must be checked" };
      return { ok: true, value: checked };
    }
    case "multiselect": {
      // An empty selection never reaches here — validateFields' generic
      // required-check (isEmpty treats a zero-length array as empty) already
      // intercepts it with "This field is required".
      const values = Array.isArray(raw) ? raw.map(String) : [];
      if (!hasDynamicOptions(field)) {
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        if (values.some((val) => !allowed.has(val))) return { ok: false, error: "Choose only from the listed options" };
      }
      return { ok: true, value: values };
    }
    case "file": {
      if (typeof raw !== "string") return { ok: false, error: "Invalid file" };
      const match = FILE_DATA_URL_RE.exec(raw);
      if (!match) return { ok: false, error: "Invalid file upload" };
      const [, mime, base64] = match;
      const sizeKb = (base64!.length * 0.75) / 1024; // base64 inflates raw bytes by ~4/3
      const cap = field.fileMaxSizeKb ?? MAX_FILE_SIZE_KB_CAP;
      if (sizeKb > cap) return { ok: false, error: `File must be under ${cap} KB` };
      if (!fileMimeAllowed(mime!, field.fileAccept)) return { ok: false, error: "File type not allowed" };
      return { ok: true, value: raw };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: "Enter a number" };
      if (v?.min !== undefined && n < v.min) return { ok: false, error: `Must be at least ${v.min}` };
      if (v?.max !== undefined && n > v.max) return { ok: false, error: `Must be at most ${v.max}` };
      return { ok: true, value: n };
    }
    default: {
      if (typeof raw !== "string") return { ok: false, error: "Invalid value" };
      const s = raw.trim();
      if (s.length > MAX_TEXT_LENGTH) return { ok: false, error: "Too long" };
      if (field.type === "email" && !z.string().email().safeParse(s).success) {
        return { ok: false, error: "Enter a valid email" };
      }
      if (field.type === "phone" && !/^[+()\d\s.-]{5,20}$/.test(s)) {
        return { ok: false, error: "Enter a valid phone number" };
      }
      if (field.type === "date" && Number.isNaN(Date.parse(s))) return { ok: false, error: "Enter a valid date" };
      if (CHOICE_FIELD_TYPES.includes(field.type) && !hasDynamicOptions(field)) {
        // API-sourced options can change between render and submit, so only
        // static option lists are enforced server-side.
        if (!field.options?.some((o) => o.value === s)) return { ok: false, error: "Choose one of the options" };
      }
      if (field.type === "text" || field.type === "textarea") {
        if (v?.min !== undefined && s.length < v.min) return { ok: false, error: `At least ${v.min} characters` };
        if (v?.max !== undefined && s.length > v.max) return { ok: false, error: `At most ${v.max} characters` };
      }
      if (v?.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(v.pattern);
        } catch {
          return { ok: true, value: s }; // a broken tenant pattern shouldn't block every visitor
        }
        if (!re.test(s)) return { ok: false, error: v.patternMessage ?? "Invalid format" };
      }
      return { ok: true, value: s };
    }
  }
}

/** Validates the given fields only — used per-step by the renderer and for the whole form on submit. */
export function validateFields(fields: AnyFormField[], data: FormData) {
  const errors: Record<string, string> = {};
  const values: FormData = {};
  for (const field of fields) {
    if (field.type === "content") continue; // display-only — never part of the submitted data
    const raw = data[field.key];
    if (isEmpty(raw) && field.type !== "checkbox") {
      if (field.required) errors[field.key] = "This field is required";
      continue;
    }
    const result = validateValue(field, raw);
    if (result.ok) values[field.key] = result.value;
    else errors[field.key] = result.error;
  }
  return { valid: Object.keys(errors).length === 0, errors, values };
}

/** Full-submission validation: only visible fields count; hidden answers are discarded. */
export function validateSubmission(schema: FormSchema | PublicFormSchema, data: FormData) {
  const { visibleFieldIds } = resolveVisibility(schema, data);
  const fields = (schema.steps as PublicFormStep[]).flatMap((s) => s.fields).filter((f) => visibleFieldIds.has(f.id));
  return validateFields(fields, data);
}

/** Substitutes `{{fieldKey}}` in an API options URL with URL-encoded answers. */
export function renderOptionsUrl(url: string, data: FormData): string {
  return url.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, key: string) => encodeURIComponent(String(data[key] ?? "")));
}

/** Field keys an API-sourced dropdown depends on (re-fetch when these change). */
export function optionsUrlDependencies(url: string): string[] {
  return [...url.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]!);
}

/**
 * What the public endpoint serves. The API options source (URL may carry a
 * key in its query string, headers may carry auth) is replaced by just the
 * keys it depends on — the browser fetches options through the server proxy.
 */
export type PublicFormField = Omit<FormField, "optionsSource"> & { apiOptions?: { dependsOn: string[] } };
export type PublicFormStep = Omit<FormStep, "fields"> & { fields: PublicFormField[] };
export type PublicFormSchema = Omit<FormSchema, "steps"> & { steps: PublicFormStep[] };

export function toPublicFormSchema(schema: FormSchema): PublicFormSchema {
  return {
    ...schema,
    steps: schema.steps.map((step) => ({
      ...step,
      fields: step.fields.map(({ optionsSource, ...field }) =>
        optionsSource ? { ...field, apiOptions: { dependsOn: optionsUrlDependencies(optionsSource.url) } } : field,
      ),
    })),
  };
}

export const EMPTY_FORM_SCHEMA: FormSchema = {
  steps: [{ id: "step_1", title: "Step 1", fields: [] }],
  submitLabel: "Submit",
  successMessage: "Thanks! We'll be in touch.",
};
