import {
  ASK_USER,
  AskUserInput,
  DECLINED,
  defineTool,
  readForm,
} from "@harness/core";

/*
 * Shows the user a form in the chat and returns the answers (input forms
 * design). The arguments are read leniently (D18); a form that cannot be
 * shown goes back to the model as an error, so it can try again.
 */

export const askUser = defineTool({
  name: ASK_USER,
  description: [
    "Asks the user one or more questions in a form shown in the chat, and returns their answers as JSON keyed by each question's name.",
    "Use it when you need information or a decision from the user before you can continue. Put related questions in one form.",
    'Write `schema` as a JSON Schema object: one property per question, with `title` as the question and an optional `description`. Use "string" for text (add "x-multiline": true for a long answer), "string" with `enum` for one choice, "integer" or "number" for a number, "boolean" for yes/no, and "array" with `items.enum` for several choices. List the questions that must be answered in `required`.',
    'Every question except text already offers the user an "Other" box for a free-text answer, so do not add an "Other" option yourself. An answer may therefore be text instead of one of your options, a number or yes/no.',
    `Unanswered optional questions are left out. If the user skips the form, the result is an error: "${DECLINED}"`,
  ].join("\n\n"),
  input: AskUserInput,
  approval: "never",
  execute: async (input, ctx) => {
    const read = readForm(input);
    if (!read.ok) {
      return {
        data: `The form was not shown:\n${read.errors.map((e) => `- ${e}`).join("\n")}`,
        isError: true,
        details: { formErrors: read.errors },
      };
    }
    const answer = await ctx.requestInput(read.form);
    if (answer.outcome === "skipped") return { data: DECLINED, isError: true };
    return { data: answer.answers };
  },
});
