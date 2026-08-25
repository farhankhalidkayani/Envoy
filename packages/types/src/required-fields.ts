import { z } from "zod";

/**
 * The field-type vocabulary an agent's config can require from a conversation.
 * Keep this list small and closed — every entry needs a branch in
 * `buildFieldSchema` below, and the widget/dashboard render per-type too.
 */
export const RequiredFieldType = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "date",
  "select",
  "boolean",
]);
export type RequiredFieldType = z.infer<typeof RequiredFieldType>;

/**
 * One entry in Agent.requiredFields. This is authored by the tenant in the
 * portal and is the single source of truth for:
 *   1. what the agent engine must collect during a conversation,
 *   2. the Zod schema `capturedData` is validated against (see below),
 *   3. how the dashboard renders the captured record.
 */
export const RequiredFieldDef = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-z][a-zA-Z0-9_]*$/, "key must be a camelCase/snake_case identifier"),
    label: z.string().min(1),
    type: RequiredFieldType,
    required: z.boolean().default(true),
    prompt: z.string().optional(), // optional hint injected into the agent's system prompt
    options: z.array(z.string()).optional(), // only meaningful when type === "select"
  })
  .refine((field) => field.type !== "select" || (field.options?.length ?? 0) > 0, {
    message: "select fields must declare at least one option",
    path: ["options"],
  });
export type RequiredFieldDef = z.infer<typeof RequiredFieldDef>;

export const RequiredFieldsSpec = z.array(RequiredFieldDef).max(50);
export type RequiredFieldsSpec = z.infer<typeof RequiredFieldsSpec>;

/** Per-type leaf schema, before required/optional wrapping. */
function leafSchemaFor(field: RequiredFieldDef): z.ZodTypeAny {
  switch (field.type) {
    case "text":
      return z.string().min(1);
    case "email":
      return z.string().email();
    case "phone":
      // Deliberately permissive — international formats vary too much for a
      // single regex to be worth the false rejections. Normalize downstream.
      return z.string().min(5).max(20);
    case "number":
      return z.number();
    case "date":
      return z.string().datetime().or(z.string().date());
    case "select":
      return z.enum(field.options as [string, ...string[]]);
    case "boolean":
      return z.boolean();
  }
}

/**
 * Build a Zod object schema for `Conversation.capturedData` from an agent's
 * `requiredFields` config. This is the runtime bridge between tenant-authored
 * JSON config and actual validation — called by the agent engine every time
 * it extracts a value, and again when a conversation is marked complete.
 */
export function buildCapturedDataSchema(fields: RequiredFieldsSpec): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const field of fields) {
    const leaf = leafSchemaFor(field);
    shape[field.key] = field.required ? leaf : leaf.optional();
  }
  return z.object(shape).passthrough();
}

/** Convenience: validate a captured-data payload directly against a field spec. */
export function parseCapturedData(fields: RequiredFieldsSpec, data: unknown) {
  return buildCapturedDataSchema(fields).parse(data);
}

/**
 * Validate one extracted value against its field definition, independent of
 * whether the rest of capturedData is complete yet. Required-field-collection
 * happens progressively over a conversation — the engine extracts and merges
 * one value at a time, so validation has to work per-field rather than only
 * against the fully-assembled object.
 */
export function validateFieldValue(
  field: RequiredFieldDef,
  value: unknown,
): { valid: true; value: unknown } | { valid: false; error: string } {
  const result = leafSchemaFor(field).safeParse(value);
  return result.success
    ? { valid: true, value: result.data }
    : { valid: false, error: result.error.issues.map((i) => i.message).join("; ") };
}
