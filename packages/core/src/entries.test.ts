import { describe, expect, it } from "vitest";
import {
  checkFileKey,
  createEntryAccess,
  editNotice,
  EntryError,
  foldEdits,
  replaySessionEntries,
  sessionEntryVersions,
  type EntryAccessOptions,
} from "./entries.js";
import { FakeSharedEntries } from "./fake-shared-entries.js";
import type { EntryOp, Message } from "./messages.js";

const author = { by: "model", sessionId: "s", runId: "r" } as const;

function access(extra: Partial<EntryAccessOptions> = {}) {
  const sessionOps: EntryOp[] = [];
  const shared = new FakeSharedEntries();
  let n = 0;
  const entries = createEntryAccess({
    session: replaySessionEntries([]),
    sessionOps,
    shared,
    inProject: true,
    author,
    newNoteId: () => `n${++n}`,
    ...extra,
  });
  return { entries, sessionOps, shared };
}

const tool = (entries: EntryOp[]): Message => ({
  role: "tool",
  callId: "c",
  name: "files_write",
  content: "",
  isError: false,
  entries,
});

describe("checkFileKey", () => {
  it("allows letters, digits, -, _ and .", () => {
    expect(() => checkFileKey("Alice_2.notes-v1.md")).not.toThrow();
  });

  it.each(["", "a/b", "a b", "é", "a:b"])("rejects %j", (key) => {
    expect(() => checkFileKey(key)).toThrow(EntryError);
  });
});

describe("replaySessionEntries", () => {
  it("applies puts and deletes from tool results and edit messages in order", () => {
    const state = replaySessionEntries([
      { role: "user", content: "hi" },
      tool([
        { op: "put", kind: "file", key: "a", value: "1", type: "plain" },
        { op: "put", kind: "note", key: "n1", value: "fact" },
      ]),
      {
        role: "edit",
        content: "",
        entries: [
          { op: "put", kind: "file", key: "a", value: "2", type: "markdown" },
          { op: "delete", kind: "note", key: "n1" },
        ],
      },
    ]);
    expect([...state.file]).toEqual([["a", { value: "2", type: "markdown" }]]);
    expect(state.note.size).toBe(0);
    expect(state.used.note.has("n1")).toBe(true);
  });
});

describe("sessionEntryVersions", () => {
  it("lists one entry's changes with who made them", () => {
    const versions = sessionEntryVersions(
      [
        {
          id: "m1",
          message: tool([{ op: "put", kind: "file", key: "a", value: "1" }]),
        },
        {
          id: "m2",
          message: tool([{ op: "put", kind: "file", key: "b", value: "x" }]),
        },
        {
          id: "m3",
          message: {
            role: "edit",
            content: "",
            entries: [{ op: "delete", kind: "file", key: "a" }],
          },
        },
      ],
      "file",
      "a",
    );
    expect(versions.map((v) => [v.messageId, v.by, v.op.op])).toEqual([
      ["m1", "model", "put"],
      ["m3", "user", "delete"],
    ]);
  });
});

describe("createEntryAccess", () => {
  it("records session-scoped writes as ops and sees them at once", () => {
    const { entries, sessionOps } = access();
    expect(entries.writeFile("session", "a.md", "markdown", "# A")).toBe(true);
    expect(entries.writeFile("session", "a.md", "markdown", "# B")).toBe(false);
    expect(entries.readFile("session", "a.md")).toEqual({
      scope: "session",
      key: "a.md",
      type: "markdown",
      size: 3,
      value: "# B",
    });
    expect(entries.deleteFile("session", "a.md")).toBe(true);
    expect(entries.deleteFile("session", "a.md")).toBe(false);
    expect(sessionOps).toEqual([
      { op: "put", kind: "file", key: "a.md", value: "# A", type: "markdown" },
      { op: "put", kind: "file", key: "a.md", value: "# B", type: "markdown" },
      { op: "delete", kind: "file", key: "a.md" },
    ]);
  });

  it("writes project and global entries through SharedEntries, as the model", () => {
    const { entries, sessionOps, shared } = access();
    entries.writeFile("global", "style", "plain", "terse");
    entries.writeFile("project", "style", "plain", "lush");
    expect(entries.listFiles()).toEqual([
      { scope: "project", key: "style", type: "plain", size: 4 },
      { scope: "global", key: "style", type: "plain", size: 5 },
    ]);
    expect(sessionOps).toEqual([]);
    expect(shared.changes.map((c) => [c.scope, c.op, c.author])).toEqual([
      ["global", "put", author],
      ["project", "put", author],
    ]);
  });

  it("has no project scope in a standalone session", () => {
    const { entries } = access({ inProject: false });
    expect(entries.scopes).toEqual(["session", "global"]);
    expect(() => entries.listFiles("project")).toThrow(/not in a project/);
    expect(() => entries.writeFile("project", "a", "plain", "")).toThrow(
      EntryError,
    );
  });

  it("has only session scope without SharedEntries", () => {
    const entries = createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      inProject: true,
      author,
    });
    expect(entries.scopes).toEqual(["session"]);
  });

  it("rejects bad keys and invalid JSON", () => {
    const { entries } = access();
    expect(() => entries.writeFile("session", "a/b", "plain", "")).toThrow(
      /Invalid file key/,
    );
    expect(() => entries.writeFile("session", "a", "json", "{nope")).toThrow(
      /not valid JSON/,
    );
    expect(entries.writeFile("session", "a", "json", '{"ok":1}')).toBe(true);
  });

  it("gives notes new ids, never reusing a deleted note's id", () => {
    let n = 0;
    const ids = ["n1", "n1", "n2"];
    const { entries } = access({
      session: replaySessionEntries([
        tool([
          { op: "put", kind: "note", key: "n1", value: "old" },
          { op: "delete", kind: "note", key: "n1" },
        ]),
      ]),
      newNoteId: () => ids[n++] ?? "x",
    });
    expect(entries.addNote("session", "new")).toBe("n2");
    expect(entries.updateNote("session", "n2", "newer")).toBe(true);
    expect(entries.updateNote("session", "n1", "x")).toBe(false);
    expect(entries.listNotes("session")).toEqual([
      { scope: "session", id: "n2", text: "newer" },
    ]);
    expect(entries.deleteNote("session", "n2")).toBe(true);
  });
});

describe("foldEdits", () => {
  it("joins an edit to the next user message", () => {
    expect(
      foldEdits([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }] },
        { role: "edit", content: "[edit]", entries: [] },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
      { role: "user", content: "[edit]\n\nnext" },
    ]);
  });

  it("makes a lone edit a user message", () => {
    expect(
      foldEdits([{ role: "edit", content: "[edit]", entries: [] }]),
    ).toEqual([{ role: "user", content: "[edit]" }]);
  });

  it("leaves consecutive user messages without an edit unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    expect(foldEdits(messages)).toEqual(messages);
  });
});

describe("editNotice", () => {
  it("names each change without the value", () => {
    expect(
      editNotice([
        { op: "put", kind: "file", key: "alice.md", value: "secret" },
        { op: "delete", kind: "note", key: "n1" },
      ]),
    ).toBe(
      "[The user changed session file alice.md; deleted session memory note n1 in the app.]",
    );
  });
});
