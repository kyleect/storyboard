import Database from "better-sqlite3-multiple-ciphers";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliedMigrations,
  checksum,
  loadMigrations,
  migrate,
  MigrationError,
  repairMigration,
  type Migration,
} from "./migrate.js";
import { MIGRATIONS_DIR, tempDatabase, tempDir } from "./test-helpers.js";

let db: Database.Database;
let cleanup: () => void = () => {};
afterEach(() => {
  if (db?.open) db.close();
  cleanup();
});

const m1: Migration = { version: 1, name: "one", sql: "CREATE TABLE a (x);" };
const m2: Migration = { version: 2, name: "two", sql: "CREATE TABLE b (x);" };

const tables = () =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

describe("migrate", () => {
  it("applies pending migrations in order and records checksums", () => {
    db = new Database(":memory:");
    expect(migrate(db, [m2, m1], () => "T")).toEqual([1, 2]);
    expect(tables()).toEqual(["a", "b", "schema_migrations"]);
    expect(appliedMigrations(db)).toEqual([
      { version: 1, name: "one", checksum: checksum(m1.sql), applied_at: "T" },
      { version: 2, name: "two", checksum: checksum(m2.sql), applied_at: "T" },
    ]);
  });

  it("applies only new migrations on later runs", () => {
    db = new Database(":memory:");
    migrate(db, [m1]);
    expect(migrate(db, [m1, m2])).toEqual([2]);
    expect(migrate(db, [m1, m2])).toEqual([]);
  });

  it("refuses to run when an applied file changed, with diagnostics", () => {
    db = new Database(":memory:");
    migrate(db, [m1], () => "2026-10-31T00:00:00Z");
    const changed = { ...m1, sql: "CREATE TABLE a (x, y);" };

    let error: unknown;
    try {
      migrate(db, [changed, m2]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationError);
    const e = error as MigrationError;
    expect(e.message).toContain("0001_one.sql");
    expect(e.message).toContain(checksum(m1.sql));
    expect(e.message).toContain(checksum(changed.sql));
    expect(e.message).toContain("2026-10-31T00:00:00Z");
    expect(e.details).toMatchObject({
      version: 1,
      storedChecksum: checksum(m1.sql),
      currentChecksum: checksum(changed.sql),
      appliedAt: "2026-10-31T00:00:00Z",
    });
    // Nothing else ran.
    expect(tables()).not.toContain("b");
  });

  it("runs again after the change is repaired", () => {
    db = new Database(":memory:");
    migrate(db, [m1]);
    const changed = { ...m1, sql: "CREATE TABLE a (x); -- comment" };
    expect(() => migrate(db, [changed])).toThrow(MigrationError);

    expect(repairMigration(db, [changed], 1)).toEqual({
      previous: checksum(m1.sql),
      current: checksum(changed.sql),
    });
    expect(migrate(db, [changed, m2])).toEqual([2]);
  });

  it("rolls back a failing migration and records nothing for it", () => {
    db = new Database(":memory:");
    const bad: Migration = {
      version: 2,
      name: "bad",
      sql: "CREATE TABLE c (x); INSERT INTO missing VALUES (1);",
    };
    expect(() => migrate(db, [m1, bad])).toThrow(
      /0002_bad\.sql failed: no such table: missing/,
    );
    expect(tables()).toEqual(["a", "schema_migrations"]);
    expect(appliedMigrations(db).map((m) => m.version)).toEqual([1]);
  });

  it("refuses when an applied migration's file is missing", () => {
    db = new Database(":memory:");
    migrate(db, [m1, m2]);
    expect(() => migrate(db, [m1])).toThrow(
      /2 \(two\) is recorded .* file is missing/,
    );
  });

  it("refuses two migrations with the same version", () => {
    db = new Database(":memory:");
    expect(() => migrate(db, [m1, { ...m2, version: 1 }])).toThrow(
      /share version 1/,
    );
  });
});

describe("loadMigrations", () => {
  it("reads NNNN_name.sql files in numeric order", () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const dir = join(t.dir, "m");
    mkdirSync(dir);
    writeFileSync(join(dir, "0010_ten.sql"), "SELECT 10;");
    writeFileSync(join(dir, "0002_two.sql"), "SELECT 2;");
    writeFileSync(join(dir, "README.md"), "ignored");
    expect(loadMigrations(dir).map((m) => [m.version, m.name])).toEqual([
      [2, "two"],
      [10, "ten"],
    ]);
  });

  it("rejects a badly named file", () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, "init.sql"), "");
    expect(() => loadMigrations(t.dir)).toThrow(/Badly named/);
  });

  it("adds model and reasoning columns to a database created before them", () => {
    db = new Database(":memory:");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version === 1),
    );
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T')",
    ).run();

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 4),
      ),
    ).toEqual([2, 3, 4]);
    expect(
      db
        .prepare("SELECT model, reasoning_effort FROM sessions WHERE id = 's'")
        .get(),
    ).toEqual({ model: null, reasoning_effort: null });
    for (const table of ["sessions", "messages", "runs"]) {
      const cols = (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toContain("model");
      expect(cols).toContain("reasoning_effort");
    }
  });

  it("moves each run's message into run_messages and drops runs.message_id", () => {
    db = new Database(":memory:");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 3),
    );
    db.exec(`
      INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T');
      INSERT INTO messages (id, session_id, seq, message, created_at)
        VALUES ('m1', 's', 1, '{}', 'T');
      INSERT INTO runs (id, session_id, kind, message_id, status, started_at)
        VALUES ('r1', 's', 'single', 'm1', 'finished', 'T'),
               ('r2', 's', 'single', 'never-saved', 'cancelled', 'T');
    `);

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 4),
      ),
    ).toEqual([4]);
    expect(db.prepare("SELECT * FROM run_messages").all()).toEqual([
      { run_id: "r1", message_id: "m1", seq: 1 },
    ]);
    const cols = (
      db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("message_id");
  });

  it("adds sessions.trashed_at and lets events have no run, keeping event ids", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 4),
    );
    db.exec(`
      INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T');
      INSERT INTO runs (id, session_id, kind, status, started_at)
        VALUES ('r', 's', 'loop', 'finished', 'T');
      INSERT INTO events (run_id, session_id, time, type, data)
        VALUES ('r', 's', 'T', 'run.started', '{}'),
               ('r', 's', 'T', 'run.finished', '{}'),
               ('r', 's', 'T', 'run.finished', '{}');
      DELETE FROM events WHERE id = 3;
    `);

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 5),
      ),
    ).toEqual([5]);
    expect(
      db.prepare("SELECT trashed_at FROM sessions WHERE id = 's'").get(),
    ).toEqual({ trashed_at: null });
    expect(
      db.prepare("SELECT id, run_id, type FROM events ORDER BY id").all(),
    ).toEqual([
      { id: 1, run_id: "r", type: "run.started" },
      { id: 2, run_id: "r", type: "run.finished" },
    ]);
    // A deleted id is not reused, and run_id can be NULL.
    const inserted = db
      .prepare(
        "INSERT INTO events (run_id, session_id, time, type, data) VALUES (NULL, 's', 'T', 'session.trashed', '{}')",
      )
      .run();
    expect(Number(inserted.lastInsertRowid)).toBe(4);
    const indexes = (
      db.prepare("PRAGMA index_list(events)").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["events_session", "events_run"]),
    );
    // The foreign keys still hold.
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (run_id, session_id, time, type, data) VALUES ('nope', 's', 'T', 'x', '{}')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("adds projects; existing sessions become standalone", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 5),
    );
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T')",
    ).run();

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 6),
      ),
    ).toEqual([6]);
    expect(
      db
        .prepare(
          "SELECT project_id, trashed_with_project FROM sessions WHERE id = 's'",
        )
        .get(),
    ).toEqual({ project_id: null, trashed_with_project: 0 });
    expect(() =>
      db
        .prepare("UPDATE sessions SET project_id = 'nope' WHERE id = 's'")
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("adds messages.usage, filled from each message's latest message.finished", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 6),
    );
    const finished = (messageId: string, usage?: object) =>
      JSON.stringify({
        messageId,
        message: { role: "assistant", content: [] },
        finishReason: "stop",
        ...(usage ? { usage } : {}),
      });
    const insertEvent = db.prepare(
      "INSERT INTO events (run_id, session_id, time, type, data) VALUES ('r', 's', 'T', ?, ?)",
    );
    db.exec(`
      INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T');
      INSERT INTO runs (id, session_id, kind, status, started_at)
        VALUES ('r', 's', 'loop', 'finished', 'T');
      INSERT INTO messages (id, session_id, seq, message, created_at) VALUES
        ('u', 's', 1, '{"role":"user","content":"Hi"}', 'T'),
        ('a1', 's', 2, '{"role":"assistant","content":[]}', 'T'),
        ('a2', 's', 3, '{"role":"assistant","content":[]}', 'T'),
        ('a3', 's', 4, '{"role":"assistant","content":[]}', 'T'),
        ('a4', 's', 5, '{"role":"assistant","content":[]}', 'T');
    `);
    // a1: one call. a2: continued; the later call counts. a3: the latest
    // call reported none. a4: no event.
    insertEvent.run(
      "message.finished",
      finished("a1", { promptTokens: 10, completionTokens: 2 }),
    );
    insertEvent.run(
      "message.finished",
      finished("a2", { promptTokens: 20, completionTokens: 3 }),
    );
    insertEvent.run(
      "text.delta",
      JSON.stringify({
        messageId: "a2",
        contentIndex: 0,
        text: "x",
        usage: { promptTokens: 99, completionTokens: 99 },
      }),
    );
    insertEvent.run(
      "message.finished",
      finished("a2", { promptTokens: 25, completionTokens: 7 }),
    );
    insertEvent.run(
      "message.finished",
      finished("a3", { promptTokens: 30, completionTokens: 1 }),
    );
    insertEvent.run("message.finished", finished("a3"));

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 7),
      ),
    ).toEqual([7]);
    const rows = (
      db.prepare("SELECT id, usage FROM messages ORDER BY seq").all() as {
        id: string;
        usage: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      usage: r.usage === null ? null : (JSON.parse(r.usage) as unknown),
    }));
    expect(rows).toEqual([
      { id: "u", usage: null },
      { id: "a1", usage: { promptTokens: 10, completionTokens: 2 } },
      { id: "a2", usage: { promptTokens: 25, completionTokens: 7 } },
      { id: "a3", usage: null },
      { id: "a4", usage: null },
    ]);
  });

  it("adds agents; existing sessions, runs and messages have none", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 9),
    );
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 'T')",
    ).run();
    db.prepare(
      "INSERT INTO runs (id, session_id, kind, status, started_at) VALUES ('r', 's', 'loop', 'finished', 'T')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES ('m', 's', 1, '{}', 'T')",
    ).run();

    expect(
      migrate(
        db,
        all.filter((m) => m.version <= 10),
      ),
    ).toEqual([10]);
    expect(
      db.prepare("SELECT agent_id FROM sessions WHERE id = 's'").get(),
    ).toEqual({ agent_id: null });
    expect(
      db
        .prepare("SELECT agent_id, agent_version FROM runs WHERE id = 'r'")
        .get(),
    ).toEqual({ agent_id: null, agent_version: null });
    expect(
      db
        .prepare("SELECT agent_id, agent_version FROM messages WHERE id = 'm'")
        .get(),
    ).toEqual({ agent_id: null, agent_version: null });
    expect(() =>
      db.prepare("UPDATE sessions SET agent_id = 'nope' WHERE id = 's'").run(),
    ).toThrow(/FOREIGN KEY/);

    const insert = db.prepare(
      `INSERT INTO agents (id, project_id, name, prompt, tool_mode, tools, version, created_at, updated_at)
       VALUES (?, NULL, ?, '', 'allow', '[]', 1, 'T', 'T')`,
    );
    insert.run("a1", "Editor");
    // Names are unique per scope and case-sensitive (decision 4).
    expect(() => insert.run("a2", "Editor")).toThrow(/UNIQUE/);
    expect(() => insert.run("a3", "editor")).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (id, name, prompt, tool_mode, tools, version, created_at, updated_at)
           VALUES ('a4', 'X', '', 'some', '[]', 1, 'T', 'T')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("applies the project's migrations to an encrypted database", () => {
    const t = tempDatabase();
    db = t.db;
    cleanup = t.cleanup;
    expect(tables()).toEqual([
      "agent_versions",
      "agents",
      "chunk_vectors",
      "chunks",
      "chunks_fts",
      "chunks_fts_config",
      "chunks_fts_data",
      "chunks_fts_docsize",
      "chunks_fts_idx",
      "entries",
      "entry_versions",
      "events",
      "messages",
      "projects",
      "run_messages",
      "runs",
      "schema_migrations",
      "search_index_state",
      "session_tool_approvals",
      "sessions",
      "settings",
    ]);
    expect(migrate(db, loadMigrations(MIGRATIONS_DIR))).toEqual([]);
  });
});
