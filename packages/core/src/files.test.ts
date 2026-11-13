import { describe, expect, it } from "vitest";
import {
  checkFileName,
  createFileAccess,
  editNotice,
  FileError,
  foldEdits,
  replaySessionFiles,
  sessionFileVersions,
  type FileAccessOptions,
} from "./files.js";
import { FakeSharedFiles } from "./fake-shared-files.js";
import type { FileOp, Message } from "./messages.js";

const author = { by: "model", sessionId: "s", runId: "r" } as const;

function access(extra: Partial<FileAccessOptions> = {}) {
  const sessionOps: FileOp[] = [];
  const shared = new FakeSharedFiles();
  const files = createFileAccess({
    session: replaySessionFiles([]),
    sessionOps,
    shared,
    inProject: true,
    author,
    ...extra,
  });
  return { files, sessionOps, shared };
}

const tool = (files: FileOp[]): Message => ({
  role: "tool",
  callId: "c",
  name: "files_write",
  content: "",
  isError: false,
  files,
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
    expect(() => checkFileName(key)).toThrow(FileError);
  });
});

describe("replaySessionFiles", () => {
  it("applies puts and deletes from tool results and edit messages in order", () => {
    const state = replaySessionFiles([
      { role: "user", content: "hi" },
      tool([
        {
          op: "put",
          key: "a",
          value: "1",
          mediaType: "text/plain",
        },
      ]),
      {
        role: "edit",
        content: "",
        files: [
          {
            op: "put",
            key: "a",
            value: "2",
            mediaType: "text/markdown",
          },
        ],
      },
    ]);
    expect([...state.files]).toEqual([
      ["a", { value: "2", mediaType: "text/markdown" }],
    ]);
    expect(state.used.has("a")).toBe(true);
  });
});

describe("sessionFileVersions", () => {
  it("lists one file's changes with who made them", () => {
    const versions = sessionFileVersions(
      [
        {
          id: "m1",
          message: tool([{ op: "put", key: "a", value: "1" }]),
        },
        {
          id: "m2",
          message: tool([{ op: "put", key: "b", value: "x" }]),
        },
        {
          id: "m3",
          message: {
            role: "edit",
            content: "",
            files: [{ op: "delete", key: "a" }],
          },
        },
      ],
      "a",
    );
    expect(versions.map((v) => [v.messageId, v.by, v.op.op])).toEqual([
      ["m1", "model", "put"],
      ["m3", "user", "delete"],
    ]);
  });
});

describe("createFileAccess", () => {
  it("records session-scoped writes as ops and sees them at once", () => {
    const { files, sessionOps } = access();
    expect(files.writeFile("session", "a.md", "text/markdown", "# A")).toBe(
      true,
    );
    expect(files.writeFile("session", "a.md", "text/markdown", "# B")).toBe(
      false,
    );
    expect(files.readFile("session", "a.md")).toEqual({
      scope: "session",
      key: "a.md",
      mediaType: "text/markdown",
      size: 3,
      value: "# B",
    });
    expect(files.deleteFile("session", "a.md")).toBe(true);
    expect(files.deleteFile("session", "a.md")).toBe(false);
    expect(sessionOps).toEqual([
      {
        op: "put",
        key: "a.md",
        value: "# A",
        mediaType: "text/markdown",
      },
      {
        op: "put",
        key: "a.md",
        value: "# B",
        mediaType: "text/markdown",
      },
      { op: "delete", key: "a.md" },
    ]);
  });

  it("writes project and global files through SharedFiles, as the model", () => {
    const { files, sessionOps, shared } = access();
    files.writeFile("global", "style", "text/plain", "terse");
    files.writeFile("project", "style", "text/plain", "lush");
    expect(files.listFiles()).toEqual([
      { scope: "project", key: "style", mediaType: "text/plain", size: 4 },
      { scope: "global", key: "style", mediaType: "text/plain", size: 5 },
    ]);
    // Several scopes: in the usual order, once each (tool prompts D7).
    expect(
      files.listFiles(["global", "session", "global"]).map((f) => f.scope),
    ).toEqual(["global"]);
    expect(files.listFiles(["global", "project"]).map((f) => f.scope)).toEqual([
      "project",
      "global",
    ]);
    expect(sessionOps).toEqual([]);
    expect(shared.changes.map((c) => [c.scope, c.op, c.author])).toEqual([
      ["global", "put", author],
      ["project", "put", author],
    ]);
  });

  it("has no project scope in a standalone session", () => {
    const { files } = access({ inProject: false });
    expect(files.scopes).toEqual(["session", "global"]);
    expect(() => files.listFiles("project")).toThrow(/not in a project/);
    expect(() => files.writeFile("project", "a", "text/plain", "")).toThrow(
      FileError,
    );
  });

  it("has only session scope without SharedFiles", () => {
    const files = createFileAccess({
      session: replaySessionFiles([]),
      sessionOps: [],
      inProject: true,
      author,
    });
    expect(files.scopes).toEqual(["session"]);
  });

  it("rejects bad keys and invalid JSON", () => {
    const { files } = access();
    expect(() =>
      files.writeFile("session", "a/../b", "text/plain", ""),
    ).toThrow(/Invalid file name/);
    expect(() =>
      files.writeFile("session", "a", "application/json", "{nope"),
    ).toThrow(/not valid JSON/);
    expect(
      files.writeFile("session", "a", "application/json", '{"ok":1}'),
    ).toBe(true);
  });
});

describe("foldEdits", () => {
  it("joins an edit to the next user message", () => {
    expect(
      foldEdits([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }] },
        { role: "edit", content: "[edit]", files: [] },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
      { role: "user", content: "[edit]\n\nnext" },
    ]);
  });

  it("makes a lone edit a user message", () => {
    expect(foldEdits([{ role: "edit", content: "[edit]", files: [] }])).toEqual(
      [{ role: "user", content: "[edit]" }],
    );
  });

  it("keeps the files of a user message an edit is joined to", () => {
    const a = "session://photo.png";
    const b = "session://note.wav";
    expect(
      foldEdits([
        { role: "edit", content: "[edit]", files: [] },
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
        { op: "put", key: "alice.md", value: "secret" },
        { op: "delete", key: "bob.md" },
      ]),
    ).toBe(
      "[The user changed session file alice.md; deleted session file bob.md in the app.]",
    );
  });
});

describe("FileAccess.search", () => {
  it("passes the scopes on, every available scope by default", async () => {
    const queries: unknown[] = [];
    const files = createFileAccess({
      session: replaySessionFiles([]),
      sessionOps: [],
      shared: new FakeSharedFiles(),
      inProject: false,
      author,
      search: (q) => {
        queries.push(q);
        return Promise.resolve({ hits: [], mode: "keyword" });
      },
    });
    await files.search("storm", undefined, 5);
    await files.search("storm", "global", 3);
    expect(queries).toEqual([
      { query: "storm", scopes: ["session", "global"], limit: 5 },
      { query: "storm", scopes: ["global"], limit: 3 },
    ]);
    await expect(files.search("x", "project", 5)).rejects.toThrow(
      /not in a project/,
    );
  });

  it("fails without a search backend", async () => {
    const { files } = access();
    await expect(files.search("x", undefined, 5)).rejects.toThrow(
      "Search is not available.",
    );
  });
});

describe("folders", () => {
  it("lists explicit folders and the folders above files, in a session", () => {
    const { files, sessionOps } = access();
    expect(files.createFolder("session", "notes/old")).toBe(true);
    expect(files.createFolder("session", "notes/old")).toBe(false);
    files.writeFile("session", "chars/alice.md", "text/markdown", "A");
    expect(files.listFolders("session").map((f) => f.path)).toEqual([
      "chars",
      "notes",
      "notes/old",
    ]);
    expect(sessionOps.filter((o) => o.op === "folder")).toEqual([
      { op: "folder", action: "create", path: "notes/old" },
    ]);
  });

  it("rebuilds folders from the transcript", () => {
    const state = replaySessionFiles([
      tool([{ op: "folder", action: "create", path: "a" }]),
      tool([{ op: "folder", action: "create", path: "b" }]),
      tool([{ op: "folder", action: "delete", path: "a" }]),
    ]);
    expect([...state.folders]).toEqual(["b"]);
  });

  it("refuses a name that is both a file and a folder", () => {
    const { files } = access();
    files.writeFile("session", "a", "text/plain", "x");
    expect(() => files.createFolder("session", "a")).toThrow(/is a file/);
    expect(() =>
      files.writeFile("session", "a/b.md", "text/plain", "x"),
    ).toThrow(/is a file/);
    files.createFolder("session", "dir");
    expect(() => files.writeFile("session", "dir", "text/plain", "x")).toThrow(
      /is a folder/,
    );
  });

  it("renames a session folder with its files and explicit subfolders", () => {
    const { files } = access();
    files.writeFile("session", "a/one.md", "text/markdown", "1");
    files.writeFile("session", "a/b/two.md", "text/plain", "2");
    files.createFolder("session", "a/empty");
    expect(files.renameFolder("session", "a", "z")).toEqual({ files: 2 });
    expect(files.listFiles("session").map((f) => f.key)).toEqual([
      "z/one.md",
      "z/b/two.md",
    ]);
    expect(files.readFile("session", "z/b/two.md")?.mediaType).toBe(
      "text/plain",
    );
    expect(files.listFolders("session").map((f) => f.path)).toEqual([
      "z",
      "z/b",
      "z/empty",
    ]);
    expect(files.renameFolder("session", "missing", "x")).toBeUndefined();
  });

  it("refuses to rename a folder onto something or into itself", () => {
    const { files } = access();
    files.createFolder("session", "a");
    files.createFolder("session", "b");
    files.writeFile("session", "f", "text/plain", "x");
    expect(() => files.renameFolder("session", "a", "b")).toThrow(/exists/);
    expect(() => files.renameFolder("session", "a", "f")).toThrow(/exists/);
    expect(() => files.renameFolder("session", "a", "a/c")).toThrow(/itself/);
  });

  it("deletes a session folder with the files inside it", () => {
    const { files } = access();
    files.writeFile("session", "a/one.md", "text/markdown", "1");
    files.writeFile("session", "keep.md", "text/markdown", "k");
    files.createFolder("session", "a/sub");
    expect(files.deleteFolder("session", "a")).toEqual({ files: 1 });
    expect(files.listFiles("session").map((f) => f.key)).toEqual(["keep.md"]);
    expect(files.listFolders("session")).toEqual([]);
    expect(files.deleteFolder("session", "a")).toBeUndefined();
  });

  it("works in shared scopes through SharedFiles", () => {
    const { files } = access();
    files.writeFile("project", "docs/a.md", "text/markdown", "A");
    expect(files.createFolder("project", "empty")).toBe(true);
    expect(files.renameFolder("project", "docs", "papers")).toEqual({
      files: 1,
    });
    expect(files.listFiles("project").map((f) => f.key)).toEqual([
      "papers/a.md",
    ]);
    expect(files.deleteFolder("project", "papers")).toEqual({ files: 1 });
    expect(files.listFiles("project")).toEqual([]);
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
    const sessionOps: FileOp[] = [];
    const access = createFileAccess({
      session: replaySessionFiles([]),
      sessionOps,
      shared: new FakeSharedFiles(),
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
          key: "cat.png",
          value: "",
          mediaType: "image/png",
          blob,
        },
        {
          op: "put",
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
