import { describe, expect, it } from "vitest";
import type { FormSchema } from "@envoy/types";
import { earlierFields, keyFromLabel, newField, optionFromLabel, schemaIssues, uniqueKey } from "./forms";

describe("keyFromLabel", () => {
  it("camelCases a label into a valid field key", () => {
    expect(keyFromLabel("Full name")).toBe("fullName");
    expect(keyFromLabel("Email Address")).toBe("emailAddress");
  });

  it("strips punctuation and diacritics", () => {
    expect(keyFromLabel("What's your budget?")).toBe("whatSYourBudget");
    expect(keyFromLabel("Café")).toBe("cafe");
  });

  it("prefixes with 'field' when the result wouldn't start with a lowercase letter", () => {
    expect(keyFromLabel("123 Main St")).toBe("field123MainSt");
    expect(keyFromLabel("")).toBe("field");
  });
});

describe("uniqueKey", () => {
  it("returns the base key when it's not taken", () => {
    expect(uniqueKey("email", new Set())).toBe("email");
  });

  it("appends an incrementing number until it finds a free key", () => {
    expect(uniqueKey("email", new Set(["email"]))).toBe("email2");
    expect(uniqueKey("email", new Set(["email", "email2", "email3"]))).toBe("email4");
  });
});

describe("optionFromLabel", () => {
  it("derives the value from the label via keyFromLabel", () => {
    expect(optionFromLabel("Buy a house")).toEqual({ label: "Buy a house", value: "buyAHouse" });
  });
});

describe("newField", () => {
  it("gives choice types two default options", () => {
    const field = newField("select");
    expect(field.options).toHaveLength(2);
    expect(field.type).toBe("select");
  });

  it("gives content blocks default placeholder text", () => {
    expect(newField("content").content).toBe("Add your text here.");
  });

  it("gives hidden fields a default query-param source", () => {
    expect(newField("hidden").hiddenSource).toEqual({ queryParam: "utm_source" });
  });

  it("gives plain input types no options", () => {
    expect(newField("text").options).toBeUndefined();
  });
});

describe("earlierFields", () => {
  const schema: FormSchema = {
    steps: [
      {
        id: "s1",
        fields: [
          { id: "f1", key: "a", type: "text", label: "A", required: false },
          { id: "f2", key: "b", type: "text", label: "B", required: false },
        ],
      },
      {
        id: "s2",
        fields: [{ id: "f3", key: "c", type: "text", label: "C", required: false }],
      },
    ],
    submitLabel: "Submit",
    successMessage: "Thanks",
  };

  it("returns only fields strictly before the target field", () => {
    expect(earlierFields(schema, { fieldId: "f2" }).map((f) => f.key)).toEqual(["a"]);
  });

  it("returns every field in earlier steps when targeting a whole step", () => {
    expect(earlierFields(schema, { stepId: "s2" }).map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("returns everything when the target isn't found", () => {
    expect(earlierFields(schema, { fieldId: "does-not-exist" }).map((f) => f.key)).toEqual(["a", "b", "c"]);
  });
});

describe("schemaIssues", () => {
  const validSchema: FormSchema = {
    steps: [{ id: "s1", fields: [{ id: "f1", key: "a", type: "text", label: "A", required: false }] }],
    submitLabel: "Submit",
    successMessage: "Thanks",
  };

  it("reports no issues for a valid schema", () => {
    expect(schemaIssues(validSchema)).toEqual({ byId: {}, messages: [] });
  });

  it("badges the offending field/step and produces a human-readable message", () => {
    const bad: FormSchema = {
      steps: [
        {
          id: "s1",
          fields: [{ id: "f1", key: "choice", type: "select", label: "Choice", required: false }],
        },
      ],
      submitLabel: "Submit",
      successMessage: "Thanks",
    };
    const result = schemaIssues(bad);
    expect(result.byId.f1).toBeDefined();
    expect(result.messages[0]).toContain("Choice");
  });
});
