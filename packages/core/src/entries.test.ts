import { describe, expect, it } from "vitest";
import {
  checkFileName,
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

describe("checkFileName", () => {
  it("allows letters, digits, spaces, Unicode, folders and dots inside", () => {
    expect(() => checkFileName("Alice_2.notes-v1.md")).not.toThrow();
    expect(() => checkFileName("My Photo é.png")).not.toThrow();
    expect(() => checkFileName("characters/minor/alice.md")).not.toThrow();
  });

  it.each([
    "",
    "a//b",
    "/a",
    "a/",
    ".",
    "..",
    "a/../b",
    "a.",
    "a ",
    "CON",
    "nul.txt",
    "a\u0001b",
  ])("rejects %j", (key) => {
    expect(() => checkFileName(key)).toThrow(EntryError);
  });
});

describe("replaySessionEntries", () => {
  it("applies puts and deletes from tool results and edit messages in order", () => {
    const state = replaySessionEntries([
      { role: "user", content: "hi" },
      tool([
        {
          op: "put",
          kind: "file",
          key: "a",
          value: "1",
          mediaType: "text/plain",
        },
        { op: "put", kind: "note", key: "n1", value: "fact" },
      ]),
      {
        role: "edit",
        content: "",
        entries: [
          {
            op: "put",
            kind: "file",
            key: "a",
            value: "2",
            mediaType: "text/markdown",
          },
          { op: "delete", kind: "note", key: "n1" },
        ],
      },
    ]);
    expect([...state.file]).toEqual([
      ["a", { value: "2", mediaType: "text/markdown" }],
    ]);
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
    expect(entries.writeFile("session", "a.md", "text/markdown", "# A")).toBe(
      true,
    );
    expect(entries.writeFile("session", "a.md", "text/markdown", "# B")).toBe(
      false,
    );
    expect(entries.readFile("session", "a.md")).toEqual({
      scope: "session",
      key: "a.md",
      mediaType: "text/markdown",
      size: 3,
      value: "# B",
    });
    expect(entries.deleteFile("session", "a.md")).toBe(true);
    expect(entries.deleteFile("session", "a.md")).toBe(false);
    expect(sessionOps).toEqual([
      {
        op: "put",
        kind: "file",
        key: "a.md",
        value: "# A",
        mediaType: "text/markdown",
      },
      {
        op: "put",
        kind: "file",
        key: "a.md",
        value: "# B",
        mediaType: "text/markdown",
      },
      { op: "delete", kind: "file", key: "a.md" },
    ]);
  });

  it("writes project and global entries through SharedEntries, as the model", () => {
    const { entries, sessionOps, shared } = access();
    entries.writeFile("global", "style", "text/plain", "terse");
    entries.writeFile("project", "style", "text/plain", "lush");
    expect(entries.listFiles()).toEqual([
      { scope: "project", key: "style", mediaType: "text/plain", size: 4 },
      { scope: "global", key: "style", mediaType: "text/plain", size: 5 },
    ]);
    // Several scopes: in the usual order, once each (tool prompts D7).
    expect(
      entries.listFiles(["global", "session", "global"]).map((f) => f.scope),
    ).toEqual(["global"]);
    expect(
      entries.listFiles(["global", "project"]).map((f) => f.scope),
    ).toEqual(["project", "global"]);
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
    expect(() => entries.writeFile("project", "a", "text/plain", "")).toThrow(
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
    expect(() =>
      entries.writeFile("session", "a/../b", "text/plain", ""),
    ).toThrow(/Invalid file name/);
    expect(() =>
      entries.writeFile("session", "a", "application/json", "{nope"),
    ).toThrow(/not valid JSON/);
    expect(
      entries.writeFile("session", "a", "application/json", '{"ok":1}'),
    ).toBe(true);
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

  it("keeps the files of a user message an edit is joined to", () => {
    const a = "session://photo.png";
    const b = "session://note.wav";
    expect(
      foldEdits([
        { role: "edit", content: "[edit]", entries: [] },
        { role: "user", content: "one", files: [a] },
        { role: "user", content: "two", files: [b] },
      ]),
    ).toEqual([
      {
        role: "user",
        content: "[edit]\n\none\n\ntwo",
        files: [a, b],
      },
    ]);
  });

  it("keeps the files of user messages with no edit", () => {
    const a = "session://photo.png";
    expect(
      foldEdits([
        { role: "user", content: "one", files: [a] },
        { role: "user", content: "two" },
      ]),
    ).toEqual([
      { role: "user", content: "one", files: [a] },
      { role: "user", content: "two" },
    ]);
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

describe("EntryAccess.search", () => {
  it("passes the scopes on, every available scope by default", async () => {
    const queries: unknown[] = [];
    const entries = createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      shared: new FakeSharedEntries(),
      inProject: false,
      author,
      search: (q) => {
        queries.push(q);
        return Promise.resolve({ hits: [], mode: "keyword" });
      },
    });
    await entries.search("note", "storm", undefined, 5);
    await entries.search("file", "storm", "global", 3);
    expect(queries).toEqual([
      { kind: "note", query: "storm", scopes: ["session", "global"], limit: 5 },
      { kind: "file", query: "storm", scopes: ["global"], limit: 3 },
    ]);
    await expect(entries.search("file", "x", "project", 5)).rejects.toThrow(
      /not in a project/,
    );
  });

  it("fails without a search backend", async () => {
    const { entries } = access();
    await expect(entries.search("file", "x", undefined, 5)).rejects.toThrow(
      "Search is not available.",
    );
  });
});

describe("folders", () => {
  it("lists explicit folders and the folders above files, in a session", () => {
    const { entries, sessionOps } = access();
    expect(entries.createFolder("session", "notes/old")).toBe(true);
    expect(entries.createFolder("session", "notes/old")).toBe(false);
    entries.writeFile("session", "chars/alice.md", "text/markdown", "A");
    expect(entries.listFolders("session").map((f) => f.path)).toEqual([
      "chars",
      "notes",
      "notes/old",
    ]);
    expect(sessionOps.filter((o) => o.op === "folder")).toEqual([
      { op: "folder", action: "create", path: "notes/old" },
    ]);
  });

  it("rebuilds folders from the transcript", () => {
    const state = replaySessionEntries([
      tool([{ op: "folder", action: "create", path: "a" }]),
      tool([{ op: "folder", action: "create", path: "b" }]),
      tool([{ op: "folder", action: "delete", path: "a" }]),
    ]);
    expect([...state.folders]).toEqual(["b"]);
  });

  it("refuses a name that is both a file and a folder", () => {
    const { entries } = access();
    entries.writeFile("session", "a", "text/plain", "x");
    expect(() => entries.createFolder("session", "a")).toThrow(/is a file/);
    expect(() =>
      entries.writeFile("session", "a/b.md", "text/plain", "x"),
    ).toThrow(/is a file/);
    entries.createFolder("session", "dir");
    expect(() =>
      entries.writeFile("session", "dir", "text/plain", "x"),
    ).toThrow(/is a folder/);
  });

  it("renames a session folder with its files and explicit subfolders", () => {
    const { entries } = access();
    entries.writeFile("session", "a/one.md", "text/markdown", "1");
    entries.writeFile("session", "a/b/two.md", "text/plain", "2");
    entries.createFolder("session", "a/empty");
    expect(entries.renameFolder("session", "a", "z")).toEqual({ files: 2 });
    expect(entries.listFiles("session").map((f) => f.key)).toEqual([
      "z/one.md",
      "z/b/two.md",
    ]);
    expect(entries.readFile("session", "z/b/two.md")?.mediaType).toBe(
      "text/plain",
    );
    expect(entries.listFolders("session").map((f) => f.path)).toEqual([
      "z",
      "z/b",
      "z/empty",
    ]);
    expect(entries.renameFolder("session", "missing", "x")).toBeUndefined();
  });

  it("refuses to rename a folder onto something or into itself", () => {
    const { entries } = access();
    entries.createFolder("session", "a");
    entries.createFolder("session", "b");
    entries.writeFile("session", "f", "text/plain", "x");
    expect(() => entries.renameFolder("session", "a", "b")).toThrow(/exists/);
    expect(() => entries.renameFolder("session", "a", "f")).toThrow(/exists/);
    expect(() => entries.renameFolder("session", "a", "a/c")).toThrow(/itself/);
  });

  it("deletes a session folder with the files inside it", () => {
    const { entries } = access();
    entries.writeFile("session", "a/one.md", "text/markdown", "1");
    entries.writeFile("session", "keep.md", "text/markdown", "k");
    entries.createFolder("session", "a/sub");
    expect(entries.deleteFolder("session", "a")).toEqual({ files: 1 });
    expect(entries.listFiles("session").map((f) => f.key)).toEqual(["keep.md"]);
    expect(entries.listFolders("session")).toEqual([]);
    expect(entries.deleteFolder("session", "a")).toBeUndefined();
  });

  it("works in shared scopes through SharedEntries", () => {
    const { entries } = access();
    entries.writeFile("project", "docs/a.md", "text/markdown", "A");
    expect(entries.createFolder("project", "empty")).toBe(true);
    expect(entries.renameFolder("project", "docs", "papers")).toEqual({
      files: 1,
    });
    expect(entries.listFiles("project").map((f) => f.key)).toEqual([
      "papers/a.md",
    ]);
    expect(entries.deleteFolder("project", "papers")).toEqual({ files: 1 });
    expect(entries.listFiles("project")).toEqual([]);
  });

  it("describes folder edits in the notice for the model", () => {
    expect(
      editNotice([
        { op: "folder", action: "create", path: "a" },
        { op: "folder", action: "delete", path: "b" },
      ]),
    ).toBe(
      "[The user created session folder a; deleted session folder b in the app.]",
    );
  });
});

describe("binary files", () => {
  const blob = { hash: "b".repeat(64), size: 1234 };
  const make = () => {
    const sessionOps: EntryOp[] = [];
    const access = createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps,
      shared: new FakeSharedEntries(),
      inProject: true,
      author: { by: "user" },
    });
    return { access, sessionOps };
  };

  it("putBlob records an operation that names the bytes, and reads back", () => {
    const { access, sessionOps } = make();
    expect(access.putBlob("session", "a/cat.png", "image/png", blob)).toBe(
      true,
    );
    expect(sessionOps).toEqual([
      {
        op: "put",
        kind: "file",
        key: "a/cat.png",
        value: "",
        mediaType: "image/png",
        blob,
      },
    ]);
    expect(access.readFile("session", "a/cat.png")).toEqual({
      scope: "session",
      key: "a/cat.png",
      mediaType: "image/png",
      size: 1234,
      value: "",
      blob,
    });
    expect(access.listFiles("session")).toEqual([
      {
        scope: "session",
        key: "a/cat.png",
        mediaType: "image/png",
        size: 1234,
      },
    ]);
    expect(access.putBlob("session", "a/cat.png", "image/jpeg", blob)).toBe(
      false,
    );
  });

  it("works in the shared scopes", () => {
    const { access } = make();
    access.putBlob("global", "cat.png", "image/png", blob);
    expect(access.readFile("global", "cat.png")).toMatchObject({ blob });
  });

  it("refuses text as a binary type and bytes as a text type", () => {
    const { access } = make();
    expect(() =>
      access.writeFile("session", "x.png", "image/png", "hi"),
    ).toThrow(/binary type/);
    expect(() =>
      access.putBlob("session", "x.md", "text/markdown", blob),
    ).toThrow(/not a binary type/);
  });

  it("keeps the folder rules for a binary file's name", () => {
    const { access } = make();
    access.createFolder("session", "pics");
    expect(() => access.putBlob("session", "pics", "image/png", blob)).toThrow(
      /folder/,
    );
    access.putBlob("session", "cat.png", "image/png", blob);
    expect(() =>
      access.putBlob("session", "cat.png/x.png", "image/png", blob),
    ).toThrow(/is a file/);
  });

  it("moves a binary file with its bytes when a folder is renamed", () => {
    const { access, sessionOps } = make();
    access.putBlob("session", "a/cat.png", "image/png", blob);
    access.renameFolder("session", "a", "b");
    expect(
      sessionOps.find((o) => o.op === "put" && o.key === "b/cat.png"),
    ).toMatchObject({ blob });
    expect(access.readFile("session", "b/cat.png")).toMatchObject({ blob });
    expect(access.readFile("session", "a/cat.png")).toBeUndefined();
  });

  it("says a binary file was added, in the notice the model reads", () => {
    expect(
      editNotice([
        {
          op: "put",
          kind: "file",
          key: "cat.png",
          value: "",
          mediaType: "image/png",
          blob,
        },
        {
          op: "put",
          kind: "file",
          key: "a.md",
          value: "x",
          mediaType: "text/markdown",
        },
      ]),
    ).toBe(
      "[The user added session file cat.png; changed session file a.md in the app.]",
    );
  });
});
