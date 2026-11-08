import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  FILE_KEY_PATTERN,
  replaySessionEntries,
  type EntryOp,
  type EntrySearch,
  type Form,
  type InputAnswer,
  type SearchResult,
  type ToolContext,
  NO_AGENTS,
  NO_SUBAGENTS,
  NO_DATA,
  NO_PROJECTS,
} from "@harness/core";
import { FakeSharedEntries } from "@harness/core/testing";
import {
  entriesInstruction,
  filesDelete,
  filesFolderCreate,
  filesFolderDelete,
  filesFolderRename,
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
    projects: NO_PROJECTS,
    agents: NO_AGENTS,
    subagents: NO_SUBAGENTS,
    data: NO_DATA,
    copyLimit: 20,
    skills: [],
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
  const NAME_RULE = "Control characters are not allowed.";

  it("asks for a new file's name and scope, with the suggestions filled in", async () => {
    const { ctx, forms, sessionOps } = context({
      answers: [answer({ name: "a.md", scope: "project" })],
    });
    expect(
      await filesWrite.execute(
        {
          key: "a.md",
          mediaType: "text/markdown",
          value: "# A",
          scope: "project",
        },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "project",
        key: "a.md",
        mediaType: "text/markdown",
        created: true,
      },
    });
    expect(forms).toEqual([
      {
        title: "Save a new file",
        description: "text/markdown file, 3 characters: # A",
        fields: [
          {
            name: "name",
            label: "Name",
            help: expect.stringContaining("Case-sensitive"),
            required: true,
            kind: "text",
            multiline: false,
            pattern: FILE_KEY_PATTERN,
            patternMessage: NAME_RULE,
            default: "a.md",
          },
          {
            name: "scope",
            label: "Save to",
            required: true,
            noOther: true,
            kind: "choice",
            options: ["session", "project", "global"],
            labels: {
              session: "session",
              project: "project (Ashfall) (suggested)",
              global: "global",
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

  it("needs only a value: no name, scope or type (Q18, Q19)", async () => {
    const { ctx, forms } = context({
      answers: [answer({ name: "hello.md", scope: "session" })],
    });
    expect(await filesWrite.execute({ value: "Hello" }, ctx)).toEqual({
      data: {
        scope: "session",
        key: "hello.md",
        mediaType: "text/markdown",
        created: true,
      },
    });
    expect(forms[0]?.fields[0]).not.toHaveProperty("default");
    expect(forms[0]?.fields[1]).not.toHaveProperty("default");
    expect(forms[0]?.fields[1]).toMatchObject({
      labels: { project: "project (Ashfall)" },
    });
  });

  it("tells the model when the user changed the name or the scope", async () => {
    const { ctx } = context({
      answers: [answer({ name: "b.md", scope: "session" })],
    });
    expect(
      await filesWrite.execute(
        { key: "a.md", mediaType: "text/plain", value: "x", scope: "global" },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "session",
        key: "b.md",
        mediaType: "text/plain",
        created: true,
        note: 'The user named the file "b.md" instead of your suggestion ("a.md"). The user chose the session scope instead of your suggestion (global).',
      },
    });
  });

  it("replaces a file the user names that exists in the scope picked (Q21)", async () => {
    const { ctx } = context({
      answers: [answer({ name: "old", scope: "global" })],
    });
    ctx.entries.writeFile("global", "old", "text/plain", "before");
    expect(
      await filesWrite.execute(
        { key: "new", mediaType: "text/plain", value: "after" },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "global",
        key: "old",
        mediaType: "text/plain",
        created: false,
        note: 'The user named the file "old" instead of your suggestion ("new"). This replaced the existing "old" in the global scope.',
      },
    });
    expect(ctx.entries.readFile("global", "old")?.value).toBe("after");
  });

  it("saves a file that exists in one scope there, without asking", async () => {
    const { ctx, forms } = context();
    ctx.entries.writeFile("global", "a", "text/plain", "1");
    expect(
      await filesWrite.execute(
        { key: "a", mediaType: "text/plain", value: "2", scope: "session" },
        ctx,
      ),
    ).toEqual({
      data: {
        scope: "global",
        key: "a",
        mediaType: "text/plain",
        created: false,
        note: '"a" already exists in the global scope, so it was saved there.',
      },
    });
    expect(forms).toEqual([]);
    expect(ctx.entries.readFile("global", "a")?.value).toBe("2");
  });

  it("asks which copy when the key is in several scopes", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries.writeFile("session", "a", "text/plain", "s");
    ctx.entries.writeFile("global", "a", "text/plain", "g");
    await filesWrite.execute(
      { key: "a", mediaType: "text/plain", value: "new", scope: "global" },
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
      await filesWrite.execute(
        { key: "a", mediaType: "text/plain", value: "x" },
        ctx,
      ),
    ).toEqual({
      data: "Not saved: the user chose not to save this file.",
      isError: true,
    });
    expect(ctx.entries.listFiles()).toEqual([]);
  });

  it("puts a bad suggested name in the form to be fixed; rejects bad JSON before asking", async () => {
    const { ctx, forms } = context({
      answers: [answer({ name: "a-b", scope: "session" })],
    });
    expect(
      await filesWrite.execute(
        { key: "a/b", mediaType: "text/plain", value: "" },
        ctx,
      ),
    ).toMatchObject({ data: { key: "a-b" } });
    expect(forms[0]?.fields[0]).toMatchObject({ default: "a/b" });
    expect(
      await filesWrite.execute(
        { key: "a", mediaType: "application/json", value: "{" },
        ctx,
      ),
    ).toMatchObject({
      isError: true,
      details: { reason: "rejected", key: "a", mediaType: "application/json" },
    });
    expect(forms).toHaveLength(1);
  });

  it("offers only the scopes a standalone session has", async () => {
    const { ctx, forms } = context({
      inProject: false,
      answers: [answer({ name: "a", scope: "global" })],
    });
    await filesWrite.execute(
      { key: "a", mediaType: "text/plain", value: "x", scope: "project" },
      ctx,
    );
    expect(forms[0]?.fields[1]).toMatchObject({
      options: ["session", "global"],
    });
    expect(forms[0]?.fields[1]).not.toHaveProperty("default");
  });

  it("takes only a value, and rejects an unknown type", () => {
    expect(filesWrite.parse({ value: "" }).ok).toBe(true);
    expect(
      filesWrite.parse({ key: "a", mediaType: "html", value: "" }).ok,
    ).toBe(false);
  });
});

describe("files_read and files_delete", () => {
  it("find a file by key, asking only when it is in several scopes", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries.writeFile("project", "one", "text/plain", "p");
    ctx.entries.writeFile("session", "two", "text/plain", "s");
    ctx.entries.writeFile("global", "two", "text/markdown", "g");
    expect(await filesRead.execute({ key: "one" }, ctx)).toEqual({
      data: {
        scope: "project",
        key: "one",
        mediaType: "text/plain",
        value: "p",
      },
    });
    expect(forms).toEqual([]);
    expect(await filesRead.execute({ key: "two" }, ctx)).toEqual({
      data: {
        scope: "global",
        key: "two",
        mediaType: "text/markdown",
        value: "g",
      },
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
    expect(await filesDelete.execute({ key: "a/../b" }, ctx)).toMatchObject({
      isError: true,
      details: { reason: "rejected", key: "a/../b" },
    });
    ctx.entries.writeFile("session", "two", "text/plain", "s");
    ctx.entries.writeFile("global", "two", "text/plain", "g");
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
    ctx.entries.writeFile("session", "a", "text/markdown", "# A");
    ctx.entries.writeFile("global", "a", "text/plain", "g");
    expect(await filesList.execute({}, ctx)).toEqual({
      data: {
        files: [
          { scope: "session", key: "a", mediaType: "text/markdown", size: 3 },
          { scope: "global", key: "a", mediaType: "text/plain", size: 1 },
        ],
        folders: [],
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
            session: "session",
            project: "project (Ashfall)",
            global: "global (suggested)",
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

  it("memory_search returns every match when no limit is given", async () => {
    const { ctx, queries } = withSearch({ hits: [], mode: "keyword+meaning" });
    await memorySearch.execute({ query: "x" }, ctx);
    expect(queries).toEqual([
      {
        kind: "note",
        query: "x",
        scopes: ["session", "project", "global"],
        limit: undefined,
      },
    ]);
  });

  it("bounds limit to 1-20 and scopes to 1-3, and needs a query", () => {
    expect(filesSearch.parse({ query: "x", limit: 21 }).ok).toBe(false);
    expect(filesSearch.parse({ query: "x", limit: 0 }).ok).toBe(false);
    expect(filesSearch.parse({ query: "x", scopes: [] }).ok).toBe(false);
    expect(memorySearch.parse({ query: "" }).ok).toBe(false);
    expect(memorySearch.parse({ query: "x", limit: 0 }).ok).toBe(false);
    expect(memorySearch.parse({ query: "x", limit: 100 }).ok).toBe(true);
    expect(memorySearch.parse({ query: "x", limit: 101 }).ok).toBe(false);
  });
});

describe("entriesInstruction", () => {
  it("says whether the conversation is in a project", () => {
    expect(entriesInstruction(true)).toMatch(/in a project: yes\.$/);
    expect(entriesInstruction(false)).toMatch(/in a project: no\.$/);
    expect(entriesInstruction(true)).toMatch(/^You can keep information/);
    expect(entriesInstruction(true)).toMatch(
      /leave out what you don't know, such as a file's name or scope/,
    );
  });
});

describe("references and folders in the files tools", () => {
  it("files_read takes a reference in angle brackets or plain, and skips the scope question", async () => {
    const { ctx, forms } = context();
    ctx.entries.writeFile("session", "My Notes.md", "text/markdown", "s");
    ctx.entries.writeFile("global", "My Notes.md", "text/markdown", "g");
    expect(
      await filesRead.execute({ key: "<global://My Notes.md>" }, ctx),
    ).toEqual({
      data: {
        scope: "global",
        key: "My Notes.md",
        mediaType: "text/markdown",
        value: "g",
      },
    });
    expect(
      await filesRead.execute({ key: "session://My Notes.md" }, ctx),
    ).toMatchObject({ data: { scope: "session", value: "s" } });
    expect(forms).toEqual([]);
  });

  it("files_read refuses a workspace reference and a scope the session does not have", async () => {
    const { ctx } = context({ inProject: false });
    expect(
      await filesRead.execute({ key: "<workspace://w1/a.md>" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "rejected" } });
    expect(
      await filesRead.execute({ key: "<project://a.md>" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "rejected" } });
  });

  it("files_write and files_delete take a reference naming the scope", async () => {
    const { ctx, forms } = context({
      answers: [answer({ name: "chars/alice.md", scope: "project" })],
    });
    expect(
      await filesWrite.execute(
        { key: "<project://chars/alice.md>", value: "A" },
        ctx,
      ),
    ).toMatchObject({
      data: { scope: "project", key: "chars/alice.md", created: true },
    });
    // A new file is still named and placed by the user in the form, with the
    // reference's name and scope as the suggestions (D1, D2).
    expect(forms).toHaveLength(1);
    expect(forms[0]?.fields[0]).toMatchObject({ default: "chars/alice.md" });
    expect(forms[0]?.fields[1]).toMatchObject({ default: "project" });
    expect(
      await filesDelete.execute({ key: "project://chars/alice.md" }, ctx),
    ).toEqual({
      data: { scope: "project", key: "chars/alice.md", deleted: true },
    });
  });

  it("files_list shows folders and can list one folder", async () => {
    const { ctx } = context();
    ctx.entries.writeFile("session", "a/one.md", "text/markdown", "1");
    ctx.entries.writeFile("session", "a/b/two.md", "text/markdown", "2");
    ctx.entries.writeFile("session", "top.md", "text/markdown", "3");
    ctx.entries.createFolder("session", "empty");
    expect(await filesList.execute({ folder: "a" }, ctx)).toEqual({
      data: {
        files: [
          {
            scope: "session",
            key: "a/one.md",
            mediaType: "text/markdown",
            size: 1,
          },
          {
            scope: "session",
            key: "a/b/two.md",
            mediaType: "text/markdown",
            size: 1,
          },
        ],
        folders: [{ scope: "session", path: "a/b" }],
      },
    });
    expect(await filesList.execute({}, ctx)).toMatchObject({
      data: {
        folders: [
          { scope: "session", path: "a" },
          { scope: "session", path: "a/b" },
          { scope: "session", path: "empty" },
        ],
      },
    });
  });

  it("files_folder_create asks for the scope and creates the folder", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "project" })] });
    expect(
      await filesFolderCreate.execute({ path: "chars", scope: "global" }, ctx),
    ).toEqual({
      data: {
        scope: "project",
        path: "chars",
        created: true,
        note: "The user chose the project scope instead of your suggestion (global).",
      },
    });
    expect(forms[0]).toMatchObject({
      title: 'Create the folder "chars" where?',
    });
    expect(ctx.entries.listFolders("project")).toEqual([
      { scope: "project", path: "chars" },
    ]);
    // A reference names the scope, so there is no form.
    expect(
      await filesFolderCreate.execute({ path: "<session://drafts>" }, ctx),
    ).toMatchObject({
      data: { scope: "session", path: "drafts", created: true },
    });
    expect(forms).toHaveLength(1);
  });

  it("files_folder_create rejects a bad name and a skipped form is not an error to report", async () => {
    const { ctx } = context({ answers: [SKIP] });
    expect(
      await filesFolderCreate.execute({ path: "a/../b" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "rejected" } });
    expect(await filesFolderCreate.execute({ path: "ok" }, ctx)).toEqual({
      data: "Not created: the user chose not to create it.",
      isError: true,
    });
  });

  it("files_folder_rename moves a folder and what is inside it", async () => {
    const { ctx } = context();
    ctx.entries.writeFile("session", "a/one.md", "text/markdown", "1");
    expect(
      await filesFolderRename.execute({ path: "a", newPath: "z" }, ctx),
    ).toEqual({
      data: {
        scope: "session",
        path: "a",
        newPath: "z",
        renamed: true,
        files: 1,
      },
    });
    expect(ctx.entries.readFile("session", "z/one.md")?.value).toBe("1");
    expect(
      await filesFolderRename.execute({ path: "nope", newPath: "x" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "not_found" } });
    expect(
      await filesFolderRename.execute({ path: "z", newPath: "z/inside" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "rejected" } });
  });

  it("files_folder_delete asks which copy when a folder is in two scopes", async () => {
    const { ctx, forms } = context({ answers: [answer({ scope: "global" })] });
    ctx.entries.writeFile("session", "d/x.md", "text/markdown", "s");
    ctx.entries.writeFile("global", "d/y.md", "text/markdown", "g");
    expect(await filesFolderDelete.execute({ path: "d" }, ctx)).toEqual({
      data: { scope: "global", path: "d", deleted: true, files: 1 },
    });
    expect(forms[0]).toMatchObject({ title: 'Delete which folder "d"?' });
    expect(ctx.entries.listFiles("session")).toHaveLength(1);
    expect(ctx.entries.listFiles("global")).toEqual([]);
    expect(
      await filesFolderDelete.execute({ path: "<global://d>" }, ctx),
    ).toMatchObject({ isError: true, details: { reason: "not_found" } });
  });

  it("the folder tools never ask for approval and are in the files group", () => {
    for (const tool of [
      filesFolderCreate,
      filesFolderRename,
      filesFolderDelete,
    ]) {
      expect(tool.approval).toBe("never");
      expect(tool.group).toBe("files");
      expect(tool.alwaysOn).toBe(false);
    }
  });
});

describe("binary files in the files tools", () => {
  const blob = { hash: "a".repeat(64), size: 84_000 };

  it("files_list shows a binary file's media type and size in bytes", async () => {
    const { ctx } = context();
    ctx.entries.putBlob("session", "cat.png", "image/png", blob);
    expect(await filesList.execute({}, ctx)).toMatchObject({
      data: {
        files: [
          {
            scope: "session",
            key: "cat.png",
            mediaType: "image/png",
            size: 84_000,
          },
        ],
      },
    });
  });

  it("files_read hands an image to the model as media, with keep when asked", async () => {
    const { ctx } = context();
    ctx.entries.putBlob("session", "cat.png", "image/png", blob);
    const result = await filesRead.execute({ key: "session://cat.png" }, ctx);
    expect(result).toEqual({
      data: {
        scope: "session",
        key: "cat.png",
        mediaType: "image/png",
        size: 84_000,
        note: "This is an image. It follows this result.",
      },
      media: [{ ref: "session://cat.png" }],
    });
    const kept = await filesRead.execute(
      { key: "session://cat.png", keep: true },
      ctx,
    );
    expect(kept.media).toEqual([{ ref: "session://cat.png", keep: true }]);
  });

  it("files_read says so when the model cannot take that kind of media", async () => {
    const { ctx } = context();
    ctx.entries.putBlob("session", "cat.png", "image/png", blob);
    const result = await filesRead.execute(
      { key: "session://cat.png" },
      { ...ctx, mediaSupport: { image: false, audio: true } },
    );
    expect(result.media).toBeUndefined();
    expect(result.data).toMatchObject({
      note: "The model in use cannot take image files, so it cannot be read.",
    });
  });

  it("files_write takes text media types only", () => {
    expect(filesWrite.parse({ mediaType: "image/png", value: "x" }).ok).toBe(
      false,
    );
    expect(filesWrite.parse({ mediaType: "text/plain", value: "x" }).ok).toBe(
      true,
    );
  });

  it("files_delete removes a binary file like any other", async () => {
    const { ctx } = context();
    ctx.entries.putBlob("session", "cat.png", "image/png", blob);
    expect(
      await filesDelete.execute({ key: "session://cat.png" }, ctx),
    ).toEqual({
      data: { scope: "session", key: "cat.png", deleted: true },
    });
  });
});
