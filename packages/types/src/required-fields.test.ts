import { describe, expect, it } from "vitest";
import { buildCapturedDataSchema, RequiredFieldsSpec } from "./required-fields.js";

describe("buildCapturedDataSchema", () => {
  const fields = RequiredFieldsSpec.parse([
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "company", label: "Company", type: "text", required: false },
    {
      key: "plan",
      label: "Plan",
      type: "select",
      required: true,
      options: ["starter", "pro"],
    },
  ]);

  it("accepts a fully valid payload", () => {
    const schema = buildCapturedDataSchema(fields);
    const result = schema.parse({
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      plan: "pro",
    });
    expect(result.fullName).toBe("Ada Lovelace");
  });

  it("rejects a missing required field", () => {
    const schema = buildCapturedDataSchema(fields);
    expect(() => schema.parse({ fullName: "Ada Lovelace", plan: "pro" })).toThrow();
  });

  it("rejects an invalid email", () => {
    const schema = buildCapturedDataSchema(fields);
    expect(() =>
      schema.parse({ fullName: "Ada", email: "not-an-email", plan: "pro" }),
    ).toThrow();
  });

  it("rejects a select value outside the declared options", () => {
    const schema = buildCapturedDataSchema(fields);
    expect(() =>
      schema.parse({ fullName: "Ada", email: "ada@example.com", plan: "enterprise" }),
    ).toThrow();
  });

  it("allows omitting an optional field", () => {
    const schema = buildCapturedDataSchema(fields);
    const result = schema.parse({
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      plan: "starter",
    });
    expect(result.company).toBeUndefined();
  });
});
