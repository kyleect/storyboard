import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type Form,
  type InputAnswer,
  type ToolContext,
} from "@harness/core";
import { askUser } from "./ask-user.js";

function context(answer: InputAnswer) {
  const shown: Form[] = [];
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    sessionId: "s",
    runId: "r",
    callId: "c",
    update: () => {},
    state: undefined,
    projectId: null,
    entries: createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      inProject: false,
      author: { by: "model", sessionId: "s", runId: "r" },
    }),
    requestInput: (form) => {
      shown.push(form);
      return Promise.resolve(answer);
    },
  };
  return { ctx, shown };
}

const args = {
  schema: {
    title: "Story",
    properties: {
      genre: {
        type: "string",
        description: "Which genre?",
        enum: ["noir", "sci-fi"],
      },
    },
    required: ["genre"],
  },
};

const run = async (raw: unknown, ctx: ToolContext) => {
  const parsed = askUser.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return askUser.execute(parsed.input, ctx);
};

describe("ask_user", () => {
  it("shows the form and returns the answers", async () => {
    const { ctx, shown } = context({
      outcome: "answered",
      answers: { genre: "cozy mystery" },
    });
    expect(await run(args, ctx)).toEqual({ data: { genre: "cozy mystery" } });
    expect(shown).toEqual([
      {
        title: "Story",
        fields: [
          {
            name: "genre",
            label: "Which genre?",
            required: true,
            kind: "choice",
            options: ["noir", "sci-fi"],
          },
        ],
      },
    ]);
  });

  it("returns a skip as an error", async () => {
    const { ctx } = context({ outcome: "skipped" });
    expect(await run(args, ctx)).toEqual({
      data: "The user declined to answer.",
      isError: true,
    });
  });

  it("does not show a form it cannot draw, and says why", async () => {
    const { ctx, shown } = context({ outcome: "skipped" });
    const result = await run(
      {
        schema: {
          properties: {
            list: { type: "array", title: "List", items: { type: "string" } },
          },
        },
      },
      ctx,
    );
    expect(shown).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.data).toMatch(
      /^The form was not shown:\n- list: .*free text is not supported/,
    );
    expect(result.details).toEqual({
      formErrors: [expect.stringMatching(/^list: /) as unknown],
    });
  });

  it("runs without asking, and tells the model about Other", () => {
    expect(askUser.approval).toBe("never");
    expect(askUser.description).toContain('"Other"');
  });
});
