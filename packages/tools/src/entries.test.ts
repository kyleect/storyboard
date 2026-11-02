import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type EntryOp,
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

function context(inProject = true) {
  const sessionOps: EntryOp[] = [];
  let n = 0;
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    sessionId: "s",
    runId: "r",
    callId: "c",
    update: () => {},
    requestInput: () => Promise.reject(new Error("Not used here.")),
    state: undefined,
    projectId: inProject ? "p" : null,
    entries: createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps,
      shared: new FakeSharedEntries(),
      inProject,
      author: { by: "model", sessionId: "s", runId: "r" },
      newNoteId: () => `n${++n}`,
    }),
  };
  return { ctx, sessionOps };
}

describe("files tools", () => {
  it("write, list, read and delete", async () => {
    const { ctx, sessionOps } = context();
    expect(
      await filesWrite.execute(
        { scope: "session", key: "a.md", type: "markdown", value: "# A" },
        ctx,
      ),
    ).toEqual({
      data: { scope: "session", key: "a.md", type: "markdown", created: true },
    });
    await filesWrite.execute(
      { scope: "global", key: "a.md", type: "plain", value: "g" },
      ctx,
    );
    expect(await filesList.execute({}, ctx)).toEqual({
      data: {
        files: [
          { scope: "session", key: "a.md", type: "markdown", size: 3 },
          { scope: "global", key: "a.md", type: "plain", size: 1 },
        ],
      },
    });
    expect(
      await filesRead.execute({ scope: "session", key: "a.md" }, ctx),
    ).toEqual({
      data: { scope: "session", key: "a.md", type: "markdown", value: "# A" },
    });
    expect(
      await filesDelete.execute({ scope: "session", key: "a.md" }, ctx),
    ).toEqual({ data: { scope: "session", key: "a.md", deleted: true } });
    expect(sessionOps).toHaveLength(2);
  });

  it("returns errors for missing files, bad keys, bad JSON and no project", async () => {
    const { ctx } = context(false);
    expect(
      await filesRead.execute({ scope: "session", key: "nope" }, ctx),
    ).toEqual({
      data: { error: 'There is no session file "nope".' },
      isError: true,
      details: { reason: "not_found", scope: "session", key: "nope" },
    });
    expect(
      await filesRead.execute({ scope: "session", key: "a/b" }, ctx),
    ).toMatchObject({
      isError: true,
      details: { reason: "rejected", scope: "session", key: "a/b" },
    });
    expect(
      await filesWrite.execute(
        { scope: "session", key: "a", type: "json", value: "{" },
        ctx,
      ),
    ).toMatchObject({
      isError: true,
      details: { reason: "rejected", scope: "session", key: "a", type: "json" },
    });
    expect(await filesList.execute({ scope: "project" }, ctx)).toEqual({
      data: {
        error:
          "This conversation is not in a project, so there is no project scope.",
      },
      isError: true,
      details: { reason: "rejected", scope: "project" },
    });
    // A scope left out is left out of the details too.
    expect(await filesList.execute({}, ctx)).not.toHaveProperty("details");
  });

  it("rejects an unknown type in the input", () => {
    expect(
      filesWrite.parse({ scope: "session", key: "a", type: "html", value: "" })
        .ok,
    ).toBe(false);
  });
});

describe("memory tools", () => {
  it("add, list, update and delete", async () => {
    const { ctx } = context();
    expect(
      await memoryAdd.execute(
        { scope: "project", text: "Alice hates water" },
        ctx,
      ),
    ).toEqual({ data: { scope: "project", id: "n1" } });
    expect(
      await memoryUpdate.execute(
        { scope: "project", id: "n1", text: "Alice fears water" },
        ctx,
      ),
    ).toEqual({ data: { scope: "project", id: "n1", updated: true } });
    expect(await memoryList.execute({ scope: "project" }, ctx)).toEqual({
      data: {
        notes: [{ scope: "project", id: "n1", text: "Alice fears water" }],
      },
    });
    expect(
      await memoryDelete.execute({ scope: "project", id: "n1" }, ctx),
    ).toEqual({ data: { scope: "project", id: "n1", deleted: true } });
    expect(
      await memoryUpdate.execute(
        { scope: "project", id: "n1", text: "x" },
        ctx,
      ),
    ).toEqual({
      data: { error: 'There is no project memory note "n1".' },
      isError: true,
      details: { reason: "not_found", scope: "project", id: "n1" },
    });
    expect(
      await memoryDelete.execute({ scope: "project", id: "n1" }, ctx),
    ).toMatchObject({
      isError: true,
      details: { reason: "not_found", scope: "project", id: "n1" },
    });
  });
});

describe("entriesInstruction", () => {
  it("says whether the conversation is in a project", () => {
    expect(entriesInstruction(true)).toMatch(/in a project: yes\.$/);
    expect(entriesInstruction(false)).toMatch(/in a project: no\.$/);
    expect(entriesInstruction(true)).toMatch(/^You can keep information/);
  });
});

describe("search tools", () => {
  const withSearch = (result: SearchResult) => {
    const queries: unknown[] = [];
    const { ctx } = context();
    ctx.entries = createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      shared: new FakeSharedEntries(),
      inProject: true,
      author: { by: "model", sessionId: "s", runId: "r" },
      search: (q) => {
        queries.push(q);
        return Promise.resolve(result);
      },
    });
    return { ctx, queries };
  };

  it("files_search returns key, scope and excerpt, 5 results by default", async () => {
    const { ctx, queries } = withSearch({
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
  });

  it("memory_search returns notes and passes on a keyword-only notice", async () => {
    const { ctx, queries } = withSearch({
      hits: [
        { scope: "global", key: "n1", excerpt: "fact", matched: "keyword" },
      ],
      mode: "keyword",
      notice: "No embedding model is set.",
    });
    expect(
      await memorySearch.execute(
        { query: "x", scope: "global", limit: 2 },
        ctx,
      ),
    ).toEqual({
      data: {
        notes: [{ scope: "global", id: "n1", text: "fact" }],
        notice: "No embedding model is set.",
      },
    });
    expect(queries).toMatchObject([
      { kind: "note", scopes: ["global"], limit: 2 },
    ]);
  });

  it("bounds limit to 1-20 and needs a query", () => {
    expect(filesSearch.parse({ query: "x", limit: 21 }).ok).toBe(false);
    expect(filesSearch.parse({ query: "x", limit: 0 }).ok).toBe(false);
    expect(memorySearch.parse({ query: "" }).ok).toBe(false);
  });
});
