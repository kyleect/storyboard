import { describe, expect, it } from "vitest";
import { checkSchemaFeatures, SCHEMA_DIALECT } from "./schema-features.js";

describe("checkSchemaFeatures (decision 17)", () => {
  it("accepts the supported features, nested", () => {
    expect(
      checkSchemaFeatures({
        $schema: SCHEMA_DIALECT,
        type: "object",
        title: "Character",
        properties: {
          name: { type: "string", minLength: 1, pattern: "^[A-Z]" },
          born: { type: "string", format: "date" },
          hp: { type: "integer", minimum: 0, maximum: 100, default: 10 },
          mood: { type: "string", enum: ["wary", "hopeful"] },
          alive: { type: "boolean" },
          inventory: {
            type: "array",
            items: {
              type: "object",
              properties: { item: { type: "string" } },
              required: ["item"],
            },
          },
        },
        required: ["name"],
      }),
    ).toEqual([]);
  });

  it("accepts a top-level scalar", () => {
    expect(checkSchemaFeatures({ type: "boolean" })).toEqual([]);
  });

  it("refuses unknown keywords, such as typos", () => {
    expect(
      checkSchemaFeatures({
        type: "object",
        properties: { a: { type: "string" } },
        requird: ["a"],
      }),
    ).toEqual([
      expect.stringMatching(/^\(schema\): unsupported keyword "requird"/),
    ]);
  });

  it("refuses unsupported features and types", () => {
    expect(
      checkSchemaFeatures({ oneOf: [{ type: "string" }] }).length,
    ).toBeGreaterThan(0);
    expect(checkSchemaFeatures({ type: "null" }).length).toBeGreaterThan(0);
    expect(checkSchemaFeatures({ type: "string", format: "ipv4" })).toEqual([
      expect.stringMatching(/^format:/),
    ]);
    expect(checkSchemaFeatures([])).toEqual(["(schema): must be an object."]);
  });

  it("refuses another draft", () => {
    expect(
      checkSchemaFeatures({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "string",
      }),
    ).toEqual([expect.stringMatching(/^\$schema: only/)]);
  });

  it("checks required names, repeats and bounds", () => {
    expect(
      checkSchemaFeatures({
        type: "object",
        properties: {
          a: { type: "string", minLength: 5, maxLength: 2 },
          list: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 1,
          },
        },
        required: ["a", "a", "missing"],
      }),
    ).toEqual([
      '(schema): "missing" is required but is not a property.',
      '(schema): a name is repeated in "required".',
      "properties.a: length minimum is above its maximum.",
      "properties.list: item count minimum is above its maximum.",
    ]);
  });
});
