import { describe, expect, it } from "vitest";
import {
  AskUserInput,
  checkAnswers,
  readAskUserCall,
  readForm,
  type Form,
} from "./forms.js";

const read = (args: unknown) => readForm(AskUserInput.parse(args));

describe("readForm", () => {
  it("reads all five question kinds", () => {
    const result = read({
      title: "Story",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Title", maxLength: 80 },
          premise: {
            type: "string",
            title: "Premise",
            description: "A sentence or two.",
            "x-multiline": true,
          },
          genre: { type: "string", title: "Genre", enum: ["noir", "sci-fi"] },
          words: { type: "integer", title: "Words", minimum: 500 },
          dark: { type: "boolean", title: "Dark?" },
          themes: {
            type: "array",
            title: "Themes",
            uniqueItems: true,
            items: { type: "string", enum: ["loss", "home"] },
          },
        },
        required: ["genre", "premise"],
      },
    });
    expect(result).toEqual({
      ok: true,
      form: {
        title: "Story",
        fields: [
          {
            name: "name",
            label: "Title",
            required: false,
            kind: "text",
            multiline: false,
            maxLength: 80,
          },
          {
            name: "premise",
            label: "Premise",
            help: "A sentence or two.",
            required: true,
            kind: "text",
            multiline: true,
          },
          {
            name: "genre",
            label: "Genre",
            required: true,
            kind: "choice",
            options: ["noir", "sci-fi"],
          },
          {
            name: "words",
            label: "Words",
            required: false,
            kind: "number",
            integer: true,
            minimum: 500,
          },
          { name: "dark", label: "Dark?", required: false, kind: "boolean" },
          {
            name: "themes",
            label: "Themes",
            required: false,
            kind: "multi",
            options: ["loss", "home"],
          },
        ],
      },
    });
  });

  it("reads what models write: description as the label, the title in the schema, stray keys", () => {
    // Shapes seen from Gemma 4 (design 6.2, run 1).
    const result = read({
      schema: {
        properties: {
          genre: {
            description: "Which genre?",
            enum: ["Fantasy", "Horror"],
            type: "string",
          },
          themes: {
            description: "Themes",
            items: { enum: ["loss", "home"], type: "string" },
            type: "array",
          },
        },
        required: ["genre", "missing"],
        requiredAll: false,
        title: "Story Seeds",
      },
      required: ["genre"],
      type: "object",
    });
    expect(result).toMatchObject({
      ok: true,
      form: {
        title: "Story Seeds",
        fields: [
          { name: "genre", label: "Which genre?", required: true },
          { name: "themes", label: "Themes", kind: "multi" },
        ],
      },
    });
  });

  it("prefers the tool's title to the schema's", () => {
    const result = read({
      title: "Tool title",
      schema: {
        title: "Schema title",
        properties: { a: { type: "string", title: "A" } },
      },
    });
    expect(result).toMatchObject({ ok: true, form: { title: "Tool title" } });
  });

  it("cleans options and keeps only fitting defaults", () => {
    const result = read({
      schema: {
        properties: {
          a: {
            type: "string",
            title: "A",
            enum: [" x ", "x", "", "y"],
            default: "z",
          },
          b: { type: "integer", title: "B", maximum: 5, default: 9 },
          c: { type: "boolean", title: "C", default: true },
          d: {
            type: "array",
            title: "D",
            items: { enum: ["p", "q"] },
            default: ["q"],
          },
        },
      },
    });
    if (!result.ok) throw new Error(result.errors.join());
    const [a, b, c, d] = result.form.fields;
    expect(a).toMatchObject({ options: ["x", "y"] });
    expect(a).not.toHaveProperty("default");
    expect(b).not.toHaveProperty("default");
    expect(c).toMatchObject({ default: true });
    expect(d).toMatchObject({ default: ["q"] });
  });

  it("rejects questions it cannot show", () => {
    const result = read({
      schema: {
        properties: {
          list: { type: "array", title: "List", items: { type: "string" } },
          one: { type: "string", title: "One", enum: ["only"] },
          nolabel: { type: "string" },
          range: { type: "number", title: "R", minimum: 5, maximum: 1 },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toMatch(/^list: .*free text is not supported/);
    expect(result.errors[1]).toMatch(/^one: .*at least 2 options/);
    expect(result.errors[2]).toMatch(
      /^nolabel: needs a title or a description/,
    );
    expect(result.errors[3]).toMatch(/^range: minimum is above maximum/);
  });

  it("rejects a form with no questions", () => {
    expect(read({ schema: { properties: {} } })).toEqual({
      ok: false,
      errors: ["The form has no questions."],
    });
  });

  it("reads stored call arguments, or gives undefined", () => {
    expect(
      readAskUserCall({
        schema: { properties: { a: { type: "boolean", title: "A" } } },
      }),
    ).toMatchObject({ fields: [{ name: "a", kind: "boolean" }] });
    expect(readAskUserCall("{not json")).toBeUndefined();
    expect(readAskUserCall({ schema: { properties: {} } })).toBeUndefined();
  });
});

const form: Form = {
  fields: [
    {
      name: "title",
      label: "Title",
      required: true,
      kind: "text",
      multiline: false,
      maxLength: 5,
    },
    {
      name: "note",
      label: "Note",
      required: false,
      kind: "text",
      multiline: true,
    },
    {
      name: "genre",
      label: "Genre",
      required: false,
      kind: "choice",
      options: ["noir", "sci-fi"],
    },
    {
      name: "themes",
      label: "Themes",
      required: false,
      kind: "multi",
      options: ["loss", "home"],
    },
    {
      name: "words",
      label: "Words",
      required: false,
      kind: "number",
      integer: true,
      minimum: 1,
      maximum: 100,
    },
    { name: "dark", label: "Dark?", required: false, kind: "boolean" },
  ],
};

describe("checkAnswers", () => {
  it("accepts options, numbers and yes/no, and leaves unanswered questions out", () => {
    expect(
      checkAnswers(form, {
        title: "Ash",
        genre: "noir",
        themes: ["loss", "home"],
        words: 10,
        dark: false,
      }),
    ).toEqual({
      ok: true,
      answers: {
        title: "Ash",
        genre: "noir",
        themes: ["loss", "home"],
        words: 10,
        dark: false,
      },
    });
  });

  it('accepts "Other" text in place of every non-text value, trimmed', () => {
    expect(
      checkAnswers(form, {
        title: "Ash",
        genre: " cozy mystery ",
        themes: ["loss", "found family"],
        words: "about 3000",
        dark: "a little",
      }),
    ).toEqual({
      ok: true,
      answers: {
        title: "Ash",
        genre: "cozy mystery",
        themes: ["loss", "found family"],
        words: "about 3000",
        dark: "a little",
      },
    });
  });

  it("rejects an empty required text answer and an empty Other", () => {
    expect(
      checkAnswers(form, {
        title: "  ",
        genre: "",
        themes: ["loss", " "],
        words: "",
        dark: "",
      }),
    ).toEqual({
      ok: false,
      errors: {
        title: "Answer this question.",
        genre: 'Write your answer in "Other".',
        themes: 'Write your answer in "Other".',
        words: 'Write your answer in "Other".',
        dark: 'Write your answer in "Other".',
      },
    });
  });

  it("checks missing required answers, limits, whole numbers, repeats and unknown keys", () => {
    const missing = checkAnswers(form, {});
    expect(missing).toEqual({
      ok: false,
      errors: { title: "Answer this question." },
    });
    const bad = checkAnswers(form, {
      title: "too long",
      themes: ["loss", "loss"],
      words: 2.5,
      extra: 1,
    });
    expect(bad).toEqual({
      ok: false,
      errors: {
        "": 'There is no question "extra".',
        title: "Write at most 5 characters.",
        themes: "An answer is repeated.",
        words: "Expected a whole number.",
      },
    });
    expect(checkAnswers(form, { title: "a", words: 500 })).toMatchObject({
      errors: { words: "The highest allowed is 100." },
    });
    expect(checkAnswers(form, null)).toMatchObject({ ok: false });
  });

  it("needs at least one pick for a required multi-choice", () => {
    const f: Form = {
      fields: [
        {
          name: "m",
          label: "M",
          required: true,
          kind: "multi",
          options: ["a", "b"],
        },
      ],
    };
    expect(checkAnswers(f, { m: [] })).toEqual({
      ok: false,
      errors: { m: "Answer this question." },
    });
  });
});
