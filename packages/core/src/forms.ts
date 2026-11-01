import { z } from "zod";

/*
 * Input forms (input forms design). The model asks the user questions by
 * calling `ask_user` with a JSON Schema. The schema is read leniently (D18)
 * into a `Form`, which the UI draws and the answers are checked against.
 * Every question except free text also takes an "Other" answer: free text
 * in place of the value (D19, D21, D22).
 */

/** The tool that shows a form (D1). */
export const ASK_USER = "ask_user";

/** The result text when the user skips a form (D10). */
export const DECLINED = "The user declined to answer.";

// Every integer in a tool schema needs both bounds (tools design 6.2).
const LENGTH_LIMIT = 100000;

/** One question as the model writes it: a JSON Schema property. */
export const FormFieldInput = z.object({
  type: z
    .enum(["string", "number", "integer", "boolean", "array"])
    .describe(
      '"string" for text or one choice (with enum), "number" or "integer", "boolean" for yes/no, "array" for several choices (with items.enum).',
    ),
  title: z.string().optional().describe("The question shown to the user."),
  description: z
    .string()
    .optional()
    .describe("Help text, or the question when there is no title."),
  enum: z
    .array(z.string())
    .optional()
    .describe("The options for a one-choice question."),
  items: z
    .object({
      type: z.literal("string").optional(),
      enum: z.array(z.string()).optional(),
    })
    .optional()
    .describe('The options for a several-choice ("array") question.'),
  uniqueItems: z.boolean().optional(),
  "x-multiline": z
    .boolean()
    .optional()
    .describe("true when the answer is long text (several lines)."),
  minLength: z.int().min(0).max(LENGTH_LIMIT).optional(),
  maxLength: z.int().min(0).max(LENGTH_LIMIT).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.unknown().optional(),
});
export type FormFieldInput = z.infer<typeof FormFieldInput>;

/** The `ask_user` arguments (D3, D18). Unknown keys are ignored. */
export const AskUserInput = z.object({
  title: z.string().optional().describe("A short heading for the form."),
  schema: z
    .object({
      type: z.literal("object").optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      properties: z
        .record(z.string(), FormFieldInput)
        .describe(
          "One entry per question. Its key names the answer in the result.",
        ),
      required: z
        .array(z.string())
        .optional()
        .describe("The keys of the questions that must be answered."),
    })
    .describe(
      "A JSON Schema for the answers: an object whose properties are the questions.",
    ),
});
export type AskUserInput = z.infer<typeof AskUserInput>;

const base = {
  /** The answer's key in the result. */
  name: z.string(),
  /** The question. */
  label: z.string(),
  /** Help text under the question. */
  help: z.string().optional(),
  required: z.boolean(),
};

/** A question, read from the model's schema. */
export const FormField = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("text"),
    multiline: z.boolean(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    default: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("choice"),
    options: z.array(z.string()),
    default: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("multi"),
    options: z.array(z.string()),
    default: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("number"),
    integer: z.boolean(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("boolean"),
    default: z.boolean().optional(),
  }),
]);
export type FormField = z.infer<typeof FormField>;

/** A form to show the user. */
export const Form = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(FormField),
});
export type Form = z.infer<typeof Form>;

/** Answers keyed by question name; unanswered questions are left out. */
export type Answers = Record<string, unknown>;

/** The user's answer to a form: its answers, or skipped (D10). */
export const InputAnswer = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("answered"),
    answers: z.record(z.string(), z.unknown()),
  }),
  z.object({ outcome: z.literal("skipped") }),
]);
export type InputAnswer = z.infer<typeof InputAnswer>;

export type ReadFormResult =
  { ok: true; form: Form } | { ok: false; errors: string[] };

const clean = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Options trimmed, empty ones dropped, repeats removed. */
const cleanOptions = (options: readonly string[] | undefined) => [
  ...new Set((options ?? []).map((o) => o.trim()).filter(Boolean)),
];

/**
 * Reads the `ask_user` arguments into a form (D18): a question's label is
 * its `title`, else its `description`; the form title may be the tool's
 * `title` or the schema's; names in `required` without a question and
 * defaults of the wrong kind are ignored. Question kinds that cannot be
 * shown are errors, which go back to the model.
 */
export function readForm(input: AskUserInput): ReadFormResult {
  const errors: string[] = [];
  const required = new Set(input.schema.required ?? []);
  const fields: FormField[] = [];
  const entries = Object.entries(input.schema.properties);
  if (entries.length === 0) errors.push("The form has no questions.");

  for (const [name, f] of entries) {
    const title = clean(f.title);
    const description = clean(f.description);
    const label = title ?? description;
    if (!label) {
      errors.push(`${name}: needs a title or a description.`);
      continue;
    }
    const help = title && description ? description : undefined;
    const common = {
      name,
      label,
      ...(help ? { help } : {}),
      required: required.has(name),
    };

    switch (f.type) {
      case "string": {
        if (f.enum !== undefined) {
          const options = cleanOptions(f.enum);
          if (options.length < 2) {
            errors.push(
              `${name}: a choice needs at least 2 options; use a text question (no enum) otherwise.`,
            );
            continue;
          }
          fields.push({
            ...common,
            kind: "choice",
            options,
            ...(typeof f.default === "string" && options.includes(f.default)
              ? { default: f.default }
              : {}),
          });
          break;
        }
        if (
          f.minLength !== undefined &&
          f.maxLength !== undefined &&
          f.minLength > f.maxLength
        ) {
          errors.push(`${name}: minLength is above maxLength.`);
          continue;
        }
        fields.push({
          ...common,
          kind: "text",
          multiline: f["x-multiline"] === true,
          ...(f.minLength !== undefined ? { minLength: f.minLength } : {}),
          ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
          ...(typeof f.default === "string" ? { default: f.default } : {}),
        });
        break;
      }
      case "number":
      case "integer": {
        if (
          f.minimum !== undefined &&
          f.maximum !== undefined &&
          f.minimum > f.maximum
        ) {
          errors.push(`${name}: minimum is above maximum.`);
          continue;
        }
        const integer = f.type === "integer";
        const d = f.default;
        const goodDefault =
          typeof d === "number" &&
          Number.isFinite(d) &&
          (!integer || Number.isInteger(d)) &&
          (f.minimum === undefined || d >= f.minimum) &&
          (f.maximum === undefined || d <= f.maximum);
        fields.push({
          ...common,
          kind: "number",
          integer,
          ...(f.minimum !== undefined ? { minimum: f.minimum } : {}),
          ...(f.maximum !== undefined ? { maximum: f.maximum } : {}),
          ...(goodDefault ? { default: d } : {}),
        });
        break;
      }
      case "boolean":
        fields.push({
          ...common,
          kind: "boolean",
          ...(typeof f.default === "boolean" ? { default: f.default } : {}),
        });
        break;
      case "array": {
        const options = cleanOptions(f.items?.enum);
        if (options.length < 2) {
          errors.push(
            `${name}: an "array" question needs items.enum with at least 2 options. A list of free text is not supported; use a text question.`,
          );
          continue;
        }
        const d = f.default;
        const goodDefault =
          Array.isArray(d) &&
          d.every((v) => typeof v === "string" && options.includes(v));
        fields.push({
          ...common,
          kind: "multi",
          options,
          ...(goodDefault ? { default: [...new Set(d as string[])] } : {}),
        });
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const title = clean(input.title) ?? clean(input.schema.title);
  const description = clean(input.schema.description);
  return {
    ok: true,
    form: {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      fields,
    },
  };
}

/**
 * Reads an `ask_user` call's raw arguments, as stored in the transcript.
 * Undefined when they are not a form that could be shown.
 */
export function readAskUserCall(args: unknown): Form | undefined {
  const parsed = AskUserInput.safeParse(args);
  if (!parsed.success) return undefined;
  const read = readForm(parsed.data);
  return read.ok ? read.form : undefined;
}

export type CheckAnswersResult =
  | { ok: true; answers: Answers }
  | {
      ok: false;
      /** Problems by question name; "" for the answers as a whole. */
      errors: Record<string, string>;
    };

const ANSWER_THIS = "Answer this question.";
const WRITE_OTHER = 'Write your answer in "Other".';

/** Free text given as "Other": a string with something in it. */
const otherText = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Checks one answer; returns the problem, or the value to keep. */
function checkField(
  field: FormField,
  value: unknown,
): { error: string } | { value: unknown } {
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string") return { error: "Expected text." };
      // A required text answer cannot be empty (D17).
      if (field.required && value.trim() === "") return { error: ANSWER_THIS };
      if (field.minLength !== undefined && value.length < field.minLength)
        return { error: `Write at least ${field.minLength} characters.` };
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return { error: `Write at most ${field.maxLength} characters.` };
      return { value };
    }
    case "choice": {
      if (typeof value === "string" && field.options.includes(value))
        return { value };
      const other = otherText(value);
      // "Other" picked with an empty box (D24).
      return other !== undefined ? { value: other } : { error: WRITE_OTHER };
    }
    case "multi": {
      if (!Array.isArray(value)) return { error: "Expected a list." };
      const picked: string[] = [];
      for (const v of value) {
        if (typeof v === "string" && field.options.includes(v)) {
          picked.push(v);
          continue;
        }
        const other = otherText(v);
        if (other === undefined) return { error: WRITE_OTHER };
        picked.push(other);
      }
      if (new Set(picked).size !== picked.length)
        return { error: "An answer is repeated." };
      if (field.required && picked.length === 0) return { error: ANSWER_THIS };
      return { value: picked };
    }
    case "number": {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return { error: "Expected a number." };
        if (field.integer && !Number.isInteger(value))
          return { error: "Expected a whole number." };
        if (field.minimum !== undefined && value < field.minimum)
          return { error: `The lowest allowed is ${field.minimum}.` };
        if (field.maximum !== undefined && value > field.maximum)
          return { error: `The highest allowed is ${field.maximum}.` };
        return { value };
      }
      const other = otherText(value);
      return other !== undefined ? { value: other } : { error: WRITE_OTHER };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      const other = otherText(value);
      return other !== undefined ? { value: other } : { error: WRITE_OTHER };
    }
  }
}

/**
 * Checks answers against a form (D8). Shared by the UI, for errors next to
 * each question, and the backend, which has the final word. "Other" answers
 * are free text in place of a question's value (D22); they come back
 * trimmed.
 */
export function checkAnswers(form: Form, answers: unknown): CheckAnswersResult {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { ok: false, errors: { "": "Expected an object of answers." } };
  }
  const given = answers as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const kept: Answers = {};
  const names = new Set(form.fields.map((f) => f.name));
  for (const key of Object.keys(given)) {
    if (!names.has(key)) errors[""] = `There is no question "${key}".`;
  }
  for (const field of form.fields) {
    const value = given[field.name];
    if (value === undefined) {
      if (field.required) errors[field.name] = ANSWER_THIS;
      continue;
    }
    const result = checkField(field, value);
    if ("error" in result) errors[field.name] = result.error;
    else kept[field.name] = result.value;
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, answers: kept };
}
