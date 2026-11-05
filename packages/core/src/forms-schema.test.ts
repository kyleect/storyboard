import { describe, expect, it } from "vitest";
import {
  checkAnswers,
  readSchemaForm,
  schemaFormAnswers,
  schemaFormValue,
} from "./forms.js";
import type { SchemaNode } from "./schema-features.js";

const CHARACTER: SchemaNode = {
  type: "object",
  description: "A person in the story.",
  properties: {
    name: { type: "string", title: "Name", pattern: "^[A-Z]" },
    born: { type: "string", format: "date" },
    hp: { type: "integer", minimum: 0, maximum: 100, default: 10 },
    tier: { type: "integer", enum: [1, 2, 3] },
    mood: { type: "string", enum: ["wary", "hopeful"] },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    inventory: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: { item: { type: "string" }, n: { type: "integer" } },
        required: ["item"],
      },
    },
    alive: { type: "boolean" },
  },
  required: ["name"],
};

describe("readSchemaForm (decisions 19, 20)", () => {
  it("draws each feature as a field, with no Other", () => {
    const form = readSchemaForm(CHARACTER, "New character");
    expect(form.title).toBe("New character");
    expect(form.description).toBe("A person in the story.");
    expect(form.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["name", "text", true],
      ["born", "text", false],
      ["hp", "number", false],
      ["tier", "choice", false],
      ["mood", "choice", false],
      ["tags", "multi", false],
      ["inventory", "list", false],
      ["alive", "boolean", false],
    ]);
    expect(form.fields.every((f) => f.noOther)).toBe(true);
    expect(form.fields[0]).toMatchObject({ label: "Name", pattern: "^[A-Z]" });
    expect(form.fields[1]).toMatchObject({ label: "born", format: "date" });
    expect(form.fields[3]).toMatchObject({
      numeric: true,
      options: ["1", "2", "3"],
    });
    expect(form.fields[6]).toMatchObject({
      kind: "list",
      maxItems: 2,
      item: {
        kind: "object",
        fields: [
          { name: "item", required: true },
          { name: "n", required: false },
        ],
      },
    });
  });

  it("makes a top-level scalar one field named value", () => {
    const form = readSchemaForm({ type: "boolean", title: "Done?" });
    expect(form).toMatchObject({
      scalar: true,
      fields: [{ name: "value", kind: "boolean", label: "Done?" }],
    });
    expect(schemaFormValue(form, { value: true })).toBe(true);
    expect(schemaFormAnswers(form, false)).toEqual({ value: false });
  });
});

describe("checkAnswers in groups and lists", () => {
  const form = readSchemaForm(CHARACTER);

  it("keeps a valid nested value, numbers for a numeric choice", () => {
    expect(
      checkAnswers(form, {
        name: "Mara",
        tier: "2",
        inventory: [{ item: "knife", n: 1 }],
      }),
    ).toEqual({
      ok: true,
      answers: { name: "Mara", tier: 2, inventory: [{ item: "knife", n: 1 }] },
    });
  });

  it("reports problems by path", () => {
    const result = checkAnswers(form, {
      name: "mara",
      inventory: [{ n: 1 }, { item: "rope" }, { item: "lamp" }],
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: "This is not in the expected form.",
        inventory: "Keep at most 2.",
        "inventory.0.item": "Answer this question.",
      },
    });
  });
});
