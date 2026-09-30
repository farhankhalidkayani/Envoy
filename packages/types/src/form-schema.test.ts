import { describe, expect, it } from "vitest";
import {
  FormSchema,
  renderOptionsUrl,
  resolveVisibility,
  toPublicFormSchema,
  validateFields,
  validateSubmission,
} from "./form-schema.js";

const schema = FormSchema.parse({
  steps: [
    {
      id: "s1",
      fields: [
        { id: "f1", key: "interest", type: "select", label: "Interest", required: true, options: [
          { label: "Buy", value: "buy" },
          { label: "Rent", value: "rent" },
        ] },
        { id: "f2", key: "budget", type: "number", label: "Budget", required: true,
          validation: { min: 1000 },
          visibility: { match: "all", conditions: [{ fieldKey: "interest", op: "equals", value: "buy" }] } },
        { id: "f3", key: "mortgage", type: "checkbox", label: "Need mortgage?",
          visibility: { match: "all", conditions: [{ fieldKey: "budget", op: "gt", value: 500000 }] } },
      ],
    },
    {
      id: "s2",
      visibility: { match: "any", conditions: [{ fieldKey: "interest", op: "equals", value: "rent" }] },
      fields: [
        { id: "f4", key: "city", type: "select", label: "City", required: true,
          optionsSource: { url: "https://api.example.com/cities?country={{interest}}&key=SECRET",
            headers: { Authorization: "Bearer SECRET" }, itemsPath: "data", labelKey: "name", valueKey: "id" } },
      ],
    },
  ],
});

describe("form schema", () => {
  it("rejects conditions that reference later or unknown fields", () => {
    const bad = FormSchema.safeParse({
      steps: [{ id: "s", fields: [
        { id: "a", key: "a", type: "text", label: "A", visibility: { conditions: [{ fieldKey: "b", op: "is_empty" }] } },
        { id: "b", key: "b", type: "text", label: "B" },
      ] }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects duplicate keys", () => {
    const bad = FormSchema.safeParse({
      steps: [{ id: "s", fields: [
        { id: "a", key: "x", type: "text", label: "A" },
        { id: "b", key: "x", type: "text", label: "B" },
      ] }],
    });
    expect(bad.success).toBe(false);
  });

  it("hides dependent fields and whole steps", () => {
    const v = resolveVisibility(schema, { interest: "buy", budget: 900000 });
    expect([...v.visibleFieldIds]).toEqual(["f1", "f2", "f3"]);
    expect(v.visibleStepIds.has("s2")).toBe(false);
  });

  it("cascades: hiding a field drops its answer before later conditions see it", () => {
    // budget is stale (interest switched to rent) so mortgage must hide too
    const v = resolveVisibility(schema, { interest: "rent", budget: 900000, mortgage: true });
    expect(v.visibleFieldIds.has("f2")).toBe(false);
    expect(v.visibleFieldIds.has("f3")).toBe(false);
    expect(v.data).toEqual({ interest: "rent" });
  });

  it("validates only visible fields and discards hidden answers", () => {
    const ok = validateSubmission(schema, { interest: "rent", budget: 5, city: "nyc" });
    expect(ok.valid).toBe(true);
    expect(ok.values).toEqual({ interest: "rent", city: "nyc" });

    const bad = validateSubmission(schema, { interest: "buy", budget: 5 });
    expect(bad.errors).toEqual({ budget: "Must be at least 1000" });

    expect(validateSubmission(schema, { interest: "sell" }).errors.interest).toBeDefined();
  });

  it("public schema never exposes the API source", () => {
    const json = JSON.stringify(toPublicFormSchema(schema));
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("api.example.com");
    expect(json).toContain('"dependsOn":["interest"]');
  });

  it("renders dependent option urls with encoding", () => {
    expect(renderOptionsUrl("https://x.io/c?q={{a}}", { a: "a b&c" })).toBe("https://x.io/c?q=a%20b%26c");
  });

  it("content blocks need text, and never appear in submitted values", () => {
    expect(FormSchema.safeParse({ steps: [{ id: "s", fields: [{ id: "c", key: "c", type: "content" }] }] }).success).toBe(
      false,
    );
    const withContent = FormSchema.parse({
      steps: [{ id: "s", fields: [{ id: "c", key: "c", type: "content", content: "Welcome!", label: "x" }] }],
    });
    const result = validateFields(withContent.steps[0]!.fields, {});
    expect(result.valid).toBe(true);
    expect(result.values).toEqual({});
  });

  it("multiselect: required means non-empty, and only listed values are accepted", () => {
    const field = {
      id: "m",
      key: "interests",
      type: "multiselect" as const,
      label: "Interests",
      required: true,
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    };
    expect(validateFields([field], {}).errors.interests).toBe("This field is required");
    expect(validateFields([field], { interests: [] }).errors.interests).toBe("This field is required");
    expect(validateFields([field], { interests: ["a", "b"] })).toMatchObject({ valid: true, values: { interests: ["a", "b"] } });
    expect(validateFields([field], { interests: ["a", "nope"] }).errors.interests).toBe(
      "Choose only from the listed options",
    );
  });

  it("file: validates the data URL shape, size cap, and MIME allowlist", () => {
    const png1x1 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const field = { id: "f", key: "avatar", type: "file" as const, label: "Avatar", required: false, fileAccept: "image/*", fileMaxSizeKb: 100 };
    expect(validateFields([field], { avatar: png1x1 })).toMatchObject({ valid: true });
    expect(validateFields([field], { avatar: "not-a-data-url" }).errors.avatar).toBeDefined();
    expect(
      validateFields([{ ...field, fileAccept: "application/pdf" }], { avatar: png1x1 }).errors.avatar,
    ).toBe("File type not allowed");
    const big = "data:image/png;base64," + "A".repeat(200_000); // ~150KB decoded, over the 100KB cap
    expect(validateFields([field], { avatar: big }).errors.avatar).toMatch(/under 100 KB/);
  });

  it("hidden: behaves as a plain passthrough string, required still enforced", () => {
    const field = { id: "h", key: "utm_source", type: "hidden" as const, label: "UTM source", required: true };
    expect(validateFields([field], {}).errors.utm_source).toBe("This field is required");
    expect(validateFields([field], { utm_source: "newsletter" })).toMatchObject({
      valid: true,
      values: { utm_source: "newsletter" },
    });
  });
});
