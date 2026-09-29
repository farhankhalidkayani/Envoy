import { describe, expect, it } from "vitest";
import {
  FormSchema,
  renderOptionsUrl,
  resolveVisibility,
  toPublicFormSchema,
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
});
