import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import {
  renameEntriesToFiles,
  renameNoteToDecisionComment,
} from "./data-steps.js";
import { loadMigrations, migrate } from "./migrate.js";
import { MIGRATIONS_DIR } from "./test-helpers.js";

/*
 * Files only: migration 0034 (the tables `files` and `file_versions`, and
 * `chunks` without `kind`) and the data step `files-rename` (the stored
 * `entries` of tool results and edit messages become `files`, without
 * `kind`).
 */

let db: Database.Database;
afterEach(() => {
  if (db?.open) db.close();
});

const NOW = "2026-01-01T00:00:00.000Z";

describe("migration 0034", () => {
  function seeded() {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 33),
    );
    db.prepare(
      "INSERT INTO projects (id, name, created_at, last_used_at) VALUES ('p1', 'P', ?, ?)",
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', ?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO blobs (hash, media_type, size, data, created_at) VALUES ('h1', 'image/png', 1, X'00', ?)",
    ).run(NOW);
    db.prepare(
      `INSERT INTO entries (id, kind, project_id, key, media_type, value, created_at, updated_at, deleted_at, blob_hash, size)
       VALUES ('e1', 'file', NULL, 'a.md', 'text/markdown', 'alpha', ?, ?, NULL, NULL, NULL),
              ('e2', 'file', 'p1', 'cat.png', 'image/png', '', ?, ?, NULL, 'h1', 1),
              ('e3', 'file', NULL, 'gone.md', 'text/markdown', 'old', ?, ?, ?, NULL, NULL)`,
    ).run(NOW, NOW, NOW, NOW, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO entry_versions (entry_id, seq, media_type, value, deleted, author, session_id, created_at, blob_hash, size)
       VALUES ('e1', 1, 'text/markdown', 'alp', 0, 'user', NULL, ?, NULL, NULL),
              ('e1', 2, 'text/markdown', 'alpha', 0, 'model', 's', ?, NULL, NULL),
              ('e2', 1, 'image/png', '', 0, 'user', NULL, ?, 'h1', 1)`,
    ).run(NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO chunks (id, kind, scope, owner_id, key, seq, text)
       VALUES (1, 'file', 'global', NULL, 'a.md', 0, 'a lighthouse at dusk'),
              (2, 'file', 'project', 'p1', 'cat.png', 0, 'a ginger cat'),
              (7, 'file', 'workspace', 'w1', 'x/y.md', 3, 'harbour lights')`,
    ).run();
    db.prepare(
      `INSERT INTO chunk_vectors (chunk_id, model, embedding)
       VALUES (1, 'm', X'01020304'), (7, 'm', X'05060708')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, session_id, kind, status, started_at) VALUES ('r', 's', 'chat', 'finished', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO events (run_id, session_id, time, type, data)
       VALUES ('r', 's', ?, 'session.entries_changed', '{"messageId":"m"}'),
              ('r', 's', ?, 'session.renamed', '{}')`,
    ).run(NOW, NOW);
    // Up to 0034, the migration this file tests, so later ones do not move it.
    migrate(
      db,
      all.filter((m) => m.version <= 34),
    );
    return db;
  }
  const rows = (sql: string) => db.prepare(sql).all();

  it("moves the files and their versions to the new tables, keeping ids and history", () => {
    seeded();
    expect(
      rows(
        "SELECT id, project_id, key, media_type, value, deleted_at IS NOT NULL AS deleted, blob_hash, size FROM files ORDER BY id",
      ),
    ).toEqual([
      {
        id: "e1",
        project_id: null,
        key: "a.md",
        media_type: "text/markdown",
        value: "alpha",
        deleted: 0,
        blob_hash: null,
        size: null,
      },
      {
        id: "e2",
        project_id: "p1",
        key: "cat.png",
        media_type: "image/png",
        value: "",
        deleted: 0,
        blob_hash: "h1",
        size: 1,
      },
      {
        id: "e3",
        project_id: null,
        key: "gone.md",
        media_type: "text/markdown",
        value: "old",
        deleted: 1,
        blob_hash: null,
        size: null,
      },
    ]);
    expect(
      rows(
        "SELECT file_id, seq, value, author, session_id, blob_hash FROM file_versions ORDER BY file_id, seq",
      ),
    ).toEqual([
      {
        file_id: "e1",
        seq: 1,
        value: "alp",
        author: "user",
        session_id: null,
        blob_hash: null,
      },
      {
        file_id: "e1",
        seq: 2,
        value: "alpha",
        author: "model",
        session_id: "s",
        blob_hash: null,
      },
      {
        file_id: "e2",
        seq: 1,
        value: "",
        author: "user",
        session_id: null,
        blob_hash: "h1",
      },
    ]);
  });

  it("drops the old tables and keeps one file per scope and key", () => {
    seeded();
    expect(
      rows(
        "SELECT name FROM sqlite_master WHERE name IN ('entries', 'entry_versions')",
      ),
    ).toEqual([]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO files (id, project_id, key, media_type, value, created_at, updated_at)
           VALUES ('dup', NULL, 'a.md', 'text/plain', 'x', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/UNIQUE/);
    // The same key in another scope is a different file.
    db.prepare(
      `INSERT INTO files (id, project_id, key, media_type, value, created_at, updated_at)
       VALUES ('ok', 'p1', 'a.md', 'text/plain', 'x', ?, ?)`,
    ).run(NOW, NOW);
    // A file has a media type.
    expect(() =>
      db
        .prepare(
          `INSERT INTO files (id, project_id, key, media_type, value, created_at, updated_at)
           VALUES ('nomt', NULL, 'z.md', NULL, 'x', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/NOT NULL/);
  });

  it("keeps every chunk with its id, its vector and its place in the full-text index, without kind", () => {
    seeded();
    expect(
      (rows("PRAGMA table_info(chunks)") as { name: string }[]).map(
        (c) => c.name,
      ),
    ).toEqual(["id", "scope", "owner_id", "key", "seq", "text"]);
    expect(
      rows("SELECT id, scope, owner_id, key, seq FROM chunks ORDER BY id"),
    ).toEqual([
      { id: 1, scope: "global", owner_id: null, key: "a.md", seq: 0 },
      { id: 2, scope: "project", owner_id: "p1", key: "cat.png", seq: 0 },
      { id: 7, scope: "workspace", owner_id: "w1", key: "x/y.md", seq: 3 },
    ]);
    expect(
      rows(
        "SELECT chunk_id, model, hex(embedding) AS e FROM chunk_vectors ORDER BY chunk_id",
      ),
    ).toEqual([
      { chunk_id: 1, model: "m", e: "01020304" },
      { chunk_id: 7, model: "m", e: "05060708" },
    ]);
    const found = (q: string) =>
      rows(
        `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH '${q}' ORDER BY rowid`,
      ).map((r) => (r as { rowid: number }).rowid);
    expect(found("lighthouse")).toEqual([1]);
    expect(found("harbour")).toEqual([7]);
    // The trigger still keeps the index in step.
    db.prepare("DELETE FROM chunks WHERE id = 1").run();
    expect(found("lighthouse")).toEqual([]);
    expect(
      rows("SELECT count(*) AS n FROM chunk_vectors WHERE chunk_id = 1"),
    ).toEqual([{ n: 0 }]);
  });

  it("renames the stored event and leaves the others", () => {
    seeded();
    expect(rows("SELECT type FROM events ORDER BY id")).toEqual([
      { type: "session.files_changed" },
      { type: "session.renamed" },
    ]);
  });

  it("works on a database with no files", () => {
    db = new Database(":memory:");
    migrate(db, loadMigrations(MIGRATIONS_DIR));
    expect(rows("SELECT count(*) AS n FROM files")).toEqual([{ n: 0 }]);
  });
});

describe("renameEntriesToFiles", () => {
  function setup() {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, loadMigrations(MIGRATIONS_DIR));
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', ?)",
    ).run(NOW);
  }
  let seq = 0;
  const add = (id: string, message: unknown) =>
    db
      .prepare(
        "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES (?, 's', ?, ?, ?)",
      )
      .run(id, ++seq, JSON.stringify(message), NOW);
  const read = (id: string) =>
    JSON.parse(
      (
        db.prepare("SELECT message FROM messages WHERE id = ?").get(id) as {
          message: string;
        }
      ).message,
    ) as Record<string, unknown>;

  const put = { op: "put", kind: "file", key: "a.md", value: "1" };
  const del = { op: "delete", kind: "file", key: "a.md" };
  const folder = { op: "folder", action: "create", path: "d" };

  it("moves a tool result's and an edit message's changes to `files`, without kind", () => {
    setup();
    add("t", {
      role: "tool",
      callId: "c",
      name: "files_write",
      content: "{}",
      isError: false,
      entries: [put, folder, del],
    });
    add("e", { role: "edit", content: "[edit]", entries: [put] });
    expect(renameEntriesToFiles(db)).toBe(2);
    expect(read("t")).toEqual({
      role: "tool",
      callId: "c",
      name: "files_write",
      content: "{}",
      isError: false,
      files: [
        { op: "put", key: "a.md", value: "1" },
        folder,
        { op: "delete", key: "a.md" },
      ],
    });
    expect(read("e")).toEqual({
      role: "edit",
      content: "[edit]",
      files: [{ op: "put", key: "a.md", value: "1" }],
    });
  });

  it("keeps an empty list of changes (a data edit message), as `files`", () => {
    setup();
    add("e", { role: "edit", content: "[data]", entries: [] });
    expect(renameEntriesToFiles(db)).toBe(1);
    expect(read("e")).toEqual({ role: "edit", content: "[data]", files: [] });
  });

  it("leaves user messages, assistant messages and tool results with no changes alone", () => {
    setup();
    const user = {
      role: "user",
      content: "look",
      files: ["session://a.md"],
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    };
    const bare = {
      role: "tool",
      callId: "c",
      name: "x",
      content: "{}",
      isError: false,
    };
    add("u", user);
    add("a", assistant);
    add("b", bare);
    expect(renameEntriesToFiles(db)).toBe(0);
    expect(read("u")).toEqual(user);
    expect(read("a")).toEqual(assistant);
    expect(read("b")).toEqual(bare);
  });

  it("changes nothing the second time", () => {
    setup();
    add("t", {
      role: "tool",
      callId: "c",
      name: "files_write",
      content: "{}",
      isError: false,
      entries: [put],
    });
    expect(renameEntriesToFiles(db)).toBe(1);
    const once = read("t");
    expect(renameEntriesToFiles(db)).toBe(0);
    expect(read("t")).toEqual(once);
  });
});

describe("renameNoteToDecisionComment", () => {
  function setup() {
    db = new Database(":memory:");
    migrate(db, loadMigrations(MIGRATIONS_DIR));
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', ?)",
    ).run(NOW);
  }
  let seq = 0;
  const add = (id: string, message: unknown) =>
    db
      .prepare(
        "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES (?, 's', ?, ?, ?)",
      )
      .run(id, ++seq, JSON.stringify(message), NOW);
  const read = (id: string) =>
    JSON.parse(
      (
        db.prepare("SELECT message FROM messages WHERE id = ?").get(id) as {
          message: string;
        }
      ).message,
    ) as Record<string, unknown>;

  it("renames the approval note of a tool result and nothing else", () => {
    setup();
    const tool = {
      role: "tool",
      callId: "c",
      name: "x",
      content: '{"note":"inside the content stays"}',
      isError: false,
    };
    add("t", { ...tool, note: { text: "be brief", choice: "once" } });
    add("plain", tool);
    add("u", { role: "user", content: "a note" });
    expect(renameNoteToDecisionComment(db)).toBe(1);
    expect(read("t")).toEqual({
      ...tool,
      decisionComment: { text: "be brief", choice: "once" },
    });
    expect(read("plain")).toEqual(tool);
    expect(read("u")).toEqual({ role: "user", content: "a note" });
    expect(renameNoteToDecisionComment(db)).toBe(0);
  });
});
