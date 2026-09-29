import { newId, type BuilderAdapter, type PaletteItem } from "@envoy/builder";
import { FormSchema, type FormField, type FormFieldType, type FormStep } from "@envoy/types";

export const formAdapter: BuilderAdapter<FormStep, FormField> = {
  containerId: (s) => s.id,
  blockId: (f) => f.id,
  blocks: (s) => s.fields,
  withBlocks: (s, fields) => ({ ...s, fields }),
};

export const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  select: "Dropdown",
  radio: "Multiple choice",
  checkbox: "Checkbox",
};

const ICONS: Record<FormFieldType, string> = {
  text: "Aa",
  textarea: "¶",
  email: "@",
  phone: "☎",
  number: "#",
  date: "▦",
  select: "▾",
  radio: "◉",
  checkbox: "☑",
};

const GROUPS: Record<FormFieldType, string> = {
  text: "Text",
  textarea: "Text",
  email: "Contact",
  phone: "Contact",
  number: "Other",
  date: "Other",
  select: "Choice",
  radio: "Choice",
  checkbox: "Choice",
};

export function isChoice(type: FormFieldType) {
  return type === "select" || type === "radio";
}

export function newField(type: FormFieldType): FormField {
  const label = FIELD_TYPE_LABELS[type];
  return {
    id: newId("fld"),
    key: `field_${Math.random().toString(36).slice(2, 7)}`,
    type,
    label,
    required: false,
    ...(isChoice(type)
      ? {
          options: [optionFromLabel("Option 1"), optionFromLabel("Option 2")],
        }
      : {}),
  };
}

/** Palette whose new fields get a readable, unique key from their default label (e.g. "email", "email2"). */
export function fieldPalette(schema: FormSchema): PaletteItem<FormField>[] {
  const taken = new Set(schema.steps.flatMap((st) => st.fields.map((f) => f.key)));
  return (Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]).map((type) => ({
    type,
    label: FIELD_TYPE_LABELS[type],
    icon: ICONS[type],
    group: GROUPS[type],
    create: () => ({ ...newField(type), key: uniqueKey(keyFromLabel(FIELD_TYPE_LABELS[type]), taken) }),
  }));
}

export function newStep(index: number): FormStep {
  return { id: newId("step"), title: `Step ${index}`, fields: [] };
}

export function cloneField(field: FormField): FormField {
  return { ...structuredClone(field), id: newId("fld"), key: `${field.key}_${Math.random().toString(36).slice(2, 5)}` };
}

/** "Full name" -> "fullName"; always a valid field key. */
export function keyFromLabel(label: string): string {
  const words = label
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return /^[a-z]/.test(key) ? key : `field${key}`;
}

/** Option whose value tracks its label — the editor's default (non-"custom values") mode. */
export function optionFromLabel(label: string) {
  return { label, value: keyFromLabel(label) };
}

export function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Fields that come before `fieldId` (or before step `stepId`) — the only ones a condition may reference. */
export function earlierFields(schema: FormSchema, target: { fieldId?: string; stepId?: string }): FormField[] {
  const out: FormField[] = [];
  for (const step of schema.steps) {
    if (step.id === target.stepId) return out;
    for (const field of step.fields) {
      if (field.id === target.fieldId) return out;
      out.push(field);
    }
  }
  return out;
}

/**
 * Client-side run of the exact schema the server enforces, mapped from Zod
 * issue paths onto block/step ids so the canvas can badge the culprit.
 */
export function schemaIssues(schema: FormSchema): { byId: Record<string, string>; messages: string[] } {
  const result = FormSchema.safeParse(schema);
  if (result.success) return { byId: {}, messages: [] };
  const byId: Record<string, string> = {};
  const messages: string[] = [];
  for (const issue of result.error.issues) {
    const [root, si, sub, fi] = issue.path;
    const step = root === "steps" && typeof si === "number" ? schema.steps[si] : undefined;
    const field = step && sub === "fields" && typeof fi === "number" ? step.fields[fi] : undefined;
    const where = field ? `“${field.label}”` : step ? `“${step.title || `Step ${Number(si) + 1}`}”` : "Form";
    const message = `${where}: ${issue.message}`;
    const id = field?.id ?? step?.id;
    if (id && !byId[id]) byId[id] = issue.message;
    messages.push(message);
  }
  return { byId, messages };
}
