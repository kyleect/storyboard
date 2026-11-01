import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type EntryOp,
  type ToolContext,
} from "@harness/core";
import { FakeSharedEntries } from "@harness/core/testing";
import {
  entriesInstruction,
  filesDelete,
  filesList,
  filesRead,
  filesWrite,
  memoryAdd,
  memoryDelete,
  memoryList,
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
    });
    expect(
      (await filesRead.execute({ scope: "session", key: "a/b" }, ctx)).isError,
    ).toBe(true);
    expect(
      (
        await filesWrite.execute(
          { scope: "session", key: "a", type: "json", value: "{" },
          ctx,
        )
      ).isError,
    ).toBe(true);
    expect(await filesList.execute({ scope: "project" }, ctx)).toEqual({
      data: {
        error:
          "This conversation is not in a project, so there is no project scope.",
      },
      isError: true,
    });
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
      (
        await memoryUpdate.execute(
          { scope: "project", id: "n1", text: "x" },
          ctx,
        )
      ).isError,
    ).toBe(true);
  });
});

describe("entriesInstruction", () => {
  it("says whether the conversation is in a project", () => {
    expect(entriesInstruction(true)).toMatch(/in a project: yes\.$/);
    expect(entriesInstruction(false)).toMatch(/in a project: no\.$/);
    expect(entriesInstruction(true)).toMatch(/^You can keep information/);
  });
});
