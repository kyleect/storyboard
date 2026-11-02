import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type EntryOp,
  type EntrySearch,
  type Form,
  type InputAnswer,
  type SearchResult,
  type ToolContext,
} from "@harness/core";
import { FakeSharedEntries } from "@harness/core/testing";
import {
  entriesInstruction,
  filesDelete,
  filesList,
  filesRead,
  filesSearch,
  filesWrite,
  memoryAdd,
  memoryDelete,
  memoryList,
  memorySearch,
  memoryUpdate,
} from "./entries.js";

/** An answered form. */
const answer = (answers: Record<string, unknown>): InputAnswer => ({
  outcome: "answered",
  answers,
});
const SKIP: InputAnswer = { outcome: "skipped" };

/**
 * A tool context whose forms are answered from `answers`, in order. The
 * forms shown are kept in `forms`; a form with no answer left fails.
 */
function context(
  options: {
    inProject?: boolean;
    answers?: InputAnswer[];
    state?: unknown;
    search?: EntrySearch;
  } = {},
) {
  const inProject = options.inProject ?? true;
  const sessionOps: EntryOp[] = [];
  const forms: Form[] = [];
  const queue = [...(options.answers ?? [])];
  let n = 0;
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    sessionId: "s",
    runId: "r",
    callId: "c",
    update: () => {},
    requestInput: (form) => {
      forms.push(form);
      const next = queue.shift();
      return next
        ? Promise.resolve(next)
        : Promise.reject(new Error("No answer scripted."));
    },
    state: options.state,
    projectId: inProject ? "p" : null,
    projectName: inProject ? "Ashfall" : null,
    entries: createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps,
      shared: new FakeSharedEntries(),
      inProject,
      author: { by: "model", sessionId: "s", runId: "r" },
      newNoteId: () => `n${++n}`,
      ...(options.search ? { search: options.search } : {}),
    }),
  };
  /** Answers the next forms. */
  const reply = (...more: InputAnswer[]) => queue.push(...more);
  return { ctx, sessionOps, forms, reply };
}

describe("files_write", () => {
  it("asks where a new file goes, with the suggestion preselected", async () => {
    const { ctx, forms, sessionOps } = context({
      answers: [answer({ scope: "project" })],
    });
    expect(
      await filesWrite.execute(
        { key: "a.md", type: "markdown", value: "# A", scope: "project" },
        ctx,
      ),
    ).toEqual({
      data: { scope: "project", key: "a.md", type: "markdown", created: true },
    });
    expect(forms).toEqual([
      {
        title: 'Save "a.md" where?',
        description: "New markdown file, 3 characters: # A",
        fields: [
          {
            name: "scope",
            label: "Save to",
            required: true,
            noOther: true,
            kind: "choice",
            options: ["session", "project", "global"],
            labels: {
              session: "This conversation only",
              project: 'Every conversation in "Ashfall" (suggested)',
              global: "Every conversation",
            },
            default: "project",
          },
        ],
        submitLabel: "Save",
        skipLabel: "Don't save",
      },
    ]);
    expect(sessionOps).toEqual([]);
    expect(ctx.entries.readFile("project", "a.md")?.value).toBe("# A");
  });

  it("tells the model when the user overrode its suggestion", async () => {
    const { ctx } = context({ answers: [answer({ scope: "session" })] });
    expect(
      await filesWrite.execute(
        { key: "a", type: "plain", value: "x", scope: "global" },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "session",
        key: "a",
        type: "plain",
        created: true,
        note: "The user chose the session scope instead of your suggestion (global).",
      },
    });
  });

  it("preselects nothing without a suggestion", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    await filesWrite.execute({ key: "a", type: "plain", value: "x" }, ctx);
    expect(forms[0]?.fields[0]).not.toHaveProperty("default");
    expect(forms[0]?.fields[0]).toMatchObject({
      labels: { project: 'Every conversation in "Ashfall"' },
    });
  });

  it("saves a file that exists in one scope there, without asking", async () => {
    const { ctx, forms } = context({
      answers: [answer({ scope: "global" })],
    });
    await filesWrite.execute({ key: "a", type: "plain", value: "1" }, ctx);
    expect(
      await filesWrite.execute(
        { key: "a", type: "plain", value: "2", scope: "session" },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "global",
        key: "a",
        type: "plain",
        created: false,
        note: '"a" already exists in the global scope, so it was saved there.',
      },
    });
    expect(forms).toHaveLength(1);
    expect(ctx.entries.readFile("global", "a")?.value).toBe("2");
  });

  it("asks which copy when the key is in several scopes", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries.writeFile("session", "a", "plain", "s");
    ctx.entries.writeFile("global", "a", "plain", "g");
    await filesWrite.execute(
      { key: "a", type: "plain", value: "new", scope: "global" },
      ctx,
    );
    expect(forms[0]).toMatchObject({
      title: 'Replace which "a"?',
      fields: [
        {
          label: "Copy",
          options: ["session", "global"],
          default: "global",
        },
      ],
    });
    expect(ctx.entries.readFile("global", "a")?.value).toBe("new");
    expect(ctx.entries.readFile("session", "a")?.value).toBe("s");
  });

  it("writes nothing when the user does not save", async () => {
    const { ctx } = context({ answers: [SKIP] });
    expect(
      await filesWrite.execute({ key: "a", type: "plain", value: "x" }, ctx),
    ).toEqual({
      data: "Not saved: the user chose not to save this file.",
      isError: true,
    });
    expect(ctx.entries.listFiles()).toEqual([]);
  });

  it("rejects a bad key or value before asking", async () => {
    const { ctx, forms } = context();
    expect(
      await filesWrite.execute({ key: "a/b", type: "plain", value: "" }, ctx),
    ).toMatchObject({
      isError: true,
      details: { reason: "rejected", key: "a/b" },
    });
    expect(
      await filesWrite.execute({ key: "a", type: "json", value: "{" }, ctx),
    ).toMatchObject({
      isError: true,
      details: { reason: "rejected", key: "a", type: "json" },
    });
    expect(forms).toEqual([]);
  });

  it("offers only the scopes a standalone session has", async () => {
    const { ctx, forms } = context({
      inProject: false,
      answers: [answer({ scope: "global" })],
    });
    await filesWrite.execute(
      { key: "a", type: "plain", value: "x", scope: "project" },
      ctx,
    );
    expect(forms[0]?.fields[0]).toMatchObject({
      options: ["session", "global"],
    });
    expect(forms[0]?.fields[0]).not.toHaveProperty("default");
  });

  it("takes an optional suggested scope and rejects an unknown type", () => {
    expect(filesWrite.parse({ key: "a", type: "plain", value: "" }).ok).toBe(
      true,
    );
    expect(filesWrite.parse({ key: "a", type: "html", value: "" }).ok).toBe(
      false,
    );
  });
});

describe("files_read and files_delete", () => {
  it("find a file by key, asking only when it is in several scopes", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries.writeFile("project", "one", "plain", "p");
    ctx.entries.writeFile("session", "two", "plain", "s");
    ctx.entries.writeFile("global", "two", "markdown", "g");
    expect(await filesRead.execute({ key: "one" }, ctx)).toEqual({
      data: { scope: "project", key: "one", type: "plain", value: "p" },
    });
    expect(forms).toEqual([]);
    expect(await filesRead.execute({ key: "two" }, ctx)).toEqual({
      data: { scope: "global", key: "two", type: "markdown", value: "g" },
    });
    expect(forms[0]).toMatchObject({
      title: 'Read which "two"?',
      fields: [{ options: ["session", "global"] }],
      skipLabel: "Don't read",
    });
    expect(forms[0]?.fields[0]).not.toHaveProperty("default");
    expect(await filesDelete.execute({ key: "one" }, ctx)).toEqual({
      data: { scope: "project", key: "one", deleted: true },
    });
  });

  it("return not found, rejected and skipped results", async () => {
    const { ctx } = context({ answers: [SKIP] });
    expect(await filesRead.execute({ key: "nope" }, ctx)).toEqual({
      data: { error: 'There is no file "nope".' },
      isError: true,
      details: { reason: "not_found", key: "nope" },
    });
    expect(await filesDelete.execute({ key: "a/b" }, ctx)).toMatchObject({
      isError: true,
      details: { reason: "rejected", key: "a/b" },
    });
    ctx.entries.writeFile("session", "two", "plain", "s");
    ctx.entries.writeFile("global", "two", "plain", "g");
    expect(await filesDelete.execute({ key: "two" }, ctx)).toEqual({
      data: "Not deleted: the user chose not to pick a copy.",
      isError: true,
    });
    expect(ctx.entries.listFiles()).toHaveLength(2);
  });
});

describe("memory_add", () => {
  it("asks where a note goes, showing its text, and can remember", async () => {
    const { ctx, forms } = context({
      answers: [answer({ scope: "project", remember: true })],
    });
    expect(
      await memoryAdd.execute(
        { text: "Alice hates water", scope: "project" },
        ctx,
      ),
    ).toEqual({
      data: { scope: "project", id: "n1" },
      state: { scope: "project" },
    });
    expect(forms[0]).toMatchObject({
      title: "Save this note where?",
      description: "Alice hates water",
      fields: [
        { name: "scope", default: "project" },
        {
          name: "remember",
          kind: "boolean",
          label: "Use this for my notes for the rest of this session",
          noOther: true,
          default: false,
        },
      ],
    });
  });

  it("uses the remembered scope without asking", async () => {
    const { ctx, forms } = context({ state: { scope: "global" } });
    expect(
      await memoryAdd.execute({ text: "fact", scope: "session" }, ctx),
    ).toEqual({
      data: {
        scope: "global",
        id: "n1",
        note: "The user chose the global scope instead of your suggestion (session).",
      },
    });
    expect(forms).toEqual([]);
  });

  it("asks again when the remembered scope is not available", async () => {
    const { ctx, forms } = context({
      inProject: false,
      state: { scope: "project" },
      answers: [answer({ scope: "session", remember: false })],
    });
    expect(await memoryAdd.execute({ text: "fact" }, ctx)).toEqual({
      data: { scope: "session", id: "n1" },
    });
    expect(forms).toHaveLength(1);
  });

  it("saves nothing when the user does not save", async () => {
    const { ctx } = context({ answers: [SKIP] });
    expect(await memoryAdd.execute({ text: "fact" }, ctx)).toEqual({
      data: "Not saved: the user chose not to save this note.",
      isError: true,
    });
    expect(ctx.entries.listNotes()).toEqual([]);
  });
});

describe("memory_update and memory_delete", () => {
  it("find a note by id", async () => {
    const { ctx, forms } = context();
    const id = ctx.entries.addNote("project", "Alice hates water");
    expect(
      await memoryUpdate.execute({ id, text: "Alice fears water" }, ctx),
    ).toEqual({ data: { scope: "project", id, updated: true } });
    expect(ctx.entries.listNotes()).toEqual([
      { scope: "project", id, text: "Alice fears water" },
    ]);
    expect(await memoryDelete.execute({ id }, ctx)).toEqual({
      data: { scope: "project", id, deleted: true },
    });
    expect(await memoryUpdate.execute({ id, text: "x" }, ctx)).toEqual({
      data: { error: `There is no memory note "${id}".` },
      isError: true,
      details: { reason: "not_found", id },
    });
    expect(await memoryDelete.execute({ id }, ctx)).toMatchObject({
      isError: true,
      details: { reason: "not_found", id },
    });
    expect(forms).toEqual([]);
  });

  it("ask which note when the id is in several scopes", async () => {
    let n = 0;
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries = createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      shared: new FakeSharedEntries(),
      inProject: true,
      author: { by: "model", sessionId: "s", runId: "r" },
      // The same id in two scopes.
      newNoteId: () => (n++ < 2 ? "same" : `n${n}`),
    });
    ctx.entries.addNote("session", "s");
    ctx.entries.addNote("global", "g");
    expect(await memoryDelete.execute({ id: "same" }, ctx)).toEqual({
      data: { scope: "global", id: "same", deleted: true },
    });
    expect(forms[0]).toMatchObject({
      title: 'Delete which note "same"?',
      fields: [{ options: ["session", "global"] }],
    });
  });
});

describe("files_list and memory_list", () => {
  it("cover every scope without asking when no scopes are named", async () => {
    const { ctx, forms } = context();
    ctx.entries.writeFile("session", "a", "markdown", "# A");
    ctx.entries.writeFile("global", "a", "plain", "g");
    expect(await filesList.execute({}, ctx)).toEqual({
      data: {
        files: [
          { scope: "session", key: "a", type: "markdown", size: 3 },
          { scope: "global", key: "a", type: "plain", size: 1 },
        ],
      },
    });
    // Naming every scope does not narrow anything.
    await memoryList.execute({ scopes: ["global", "project", "session"] }, ctx);
    expect(forms).toEqual([]);
  });

  it("ask the user to confirm or change narrowed scopes", async () => {
    const { ctx, forms } = context({
      answers: [answer({ scopes: ["session", "global"], remember: false })],
    });
    ctx.entries.addNote("project", "p");
    ctx.entries.addNote("global", "g");
    expect(await memoryList.execute({ scopes: ["global"] }, ctx)).toEqual({
      data: {
        notes: [{ scope: "global", id: "n2", text: "g" }],
        note: "The user chose session, global instead of your suggestion (global).",
      },
    });
    expect(forms[0]).toEqual({
      title: "List notes in which scopes?",
      fields: [
        {
          name: "scopes",
          label: "Scopes",
          required: true,
          noOther: true,
          kind: "multi",
          options: ["session", "project", "global"],
          labels: {
            session: "This conversation only",
            project: 'Every conversation in "Ashfall"',
            global: "Every conversation (suggested)",
          },
          default: ["global"],
        },
        {
          name: "remember",
          label: "Use these scopes for the rest of this session",
          required: false,
          noOther: true,
          kind: "boolean",
          default: false,
        },
      ],
      submitLabel: "List",
      skipLabel: "Don't list",
    });
  });
});

describe("search tools", () => {
  const withSearch = (
    result: SearchResult,
    options: { answers?: InputAnswer[]; state?: unknown } = {},
  ) => {
    const queries: unknown[] = [];
    const c = context({
      ...options,
      search: (q) => {
        queries.push(q);
        return Promise.resolve(result);
      },
    });
    return { ...c, queries };
  };

  it("files_search covers every scope by default, 5 results", async () => {
    const { ctx, queries, forms } = withSearch({
      hits: [
        { scope: "project", key: "a.md", excerpt: "storm", matched: "both" },
      ],
      mode: "keyword+meaning",
    });
    expect(await filesSearch.execute({ query: "storm" }, ctx)).toEqual({
      data: { results: [{ scope: "project", key: "a.md", excerpt: "storm" }] },
    });
    expect(queries).toEqual([
      {
        kind: "file",
        query: "storm",
        scopes: ["session", "project", "global"],
        limit: 5,
      },
    ]);
    expect(forms).toEqual([]);
  });

  it("memory_search asks when narrowed, and remembers the choice", async () => {
    const { ctx, queries, forms } = withSearch(
      {
        hits: [
          { scope: "global", key: "n1", excerpt: "fact", matched: "keyword" },
        ],
        mode: "keyword",
        notice: "No embedding model is set.",
      },
      { answers: [answer({ scopes: ["global"], remember: true })] },
    );
    expect(
      await memorySearch.execute(
        { query: "x", scopes: ["global"], limit: 2 },
        ctx,
      ),
    ).toEqual({
      data: {
        notes: [{ scope: "global", id: "n1", text: "fact" }],
        notice: "No embedding model is set.",
      },
      state: { scopes: ["global"] },
    });
    expect(forms[0]).toMatchObject({
      title: 'Search notes for "x" in which scopes?',
      submitLabel: "Search",
      skipLabel: "Don't search",
    });
    expect(queries).toMatchObject([
      { kind: "note", scopes: ["global"], limit: 2 },
    ]);
  });

  it("uses remembered scopes without asking", async () => {
    const { ctx, queries, forms } = withSearch(
      { hits: [], mode: "keyword+meaning" },
      { state: { scopes: ["project"] } },
    );
    expect(await filesSearch.execute({ query: "x" }, ctx)).toEqual({
      data: { results: [] },
    });
    expect(queries).toMatchObject([{ scopes: ["project"] }]);
    expect(forms).toEqual([]);
  });

  it("does not search when the user skips", async () => {
    const { ctx, queries } = withSearch(
      { hits: [], mode: "keyword+meaning" },
      { answers: [SKIP] },
    );
    expect(
      await filesSearch.execute({ query: "x", scopes: ["session"] }, ctx),
    ).toEqual({
      data: "Not searched: the user chose not to search.",
      isError: true,
    });
    expect(queries).toEqual([]);
  });

  it("bounds limit to 1-20 and scopes to 1-3, and needs a query", () => {
    expect(filesSearch.parse({ query: "x", limit: 21 }).ok).toBe(false);
    expect(filesSearch.parse({ query: "x", limit: 0 }).ok).toBe(false);
    expect(filesSearch.parse({ query: "x", scopes: [] }).ok).toBe(false);
    expect(memorySearch.parse({ query: "" }).ok).toBe(false);
  });
});

describe("entriesInstruction", () => {
  it("says whether the conversation is in a project", () => {
    expect(entriesInstruction(true)).toMatch(/in a project: yes\.$/);
    expect(entriesInstruction(false)).toMatch(/in a project: no\.$/);
    expect(entriesInstruction(true)).toMatch(/^You can keep information/);
    expect(entriesInstruction(true)).toMatch(/suggest a scope/);
  });
});
