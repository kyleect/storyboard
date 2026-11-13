import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { removeMemoryFromHistory } from "./data-steps.js";
import { loadMigrations, migrate } from "./migrate.js";
import { MIGRATIONS_DIR } from "./test-helpers.js";

/*
 * Removing memory: migration 0033 (notes, tool names in stored grants and
 * settings, built-in text) and the data step `memory-removal` (stored
 * transcripts).
 */

let db: Database.Database;
afterEach(() => {
  if (db?.open) db.close();
});

const NOW = "2026-01-01T00:00:00.000Z";
const BEFORE = (m: { version: number }) => m.version < 33;
// Migration 0034 renames the tables this test reads.
const THROUGH_33 = (m: { version: number }) => m.version <= 33;

describe("migration 0033", () => {
  function seeded() {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(db, all.filter(BEFORE));

    db.prepare(
      `INSERT INTO entries (id, kind, project_id, key, media_type, value, created_at, updated_at)
       VALUES ('e1', 'file', NULL, 'f1', 'text/plain', 'keep', ?, ?),
              ('e2', 'note', NULL, 'n1', NULL, 'a note', ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO entry_versions (entry_id, seq, media_type, value, author, created_at)
       VALUES ('e1', 1, 'text/plain', 'keep', 'user', ?),
              ('e2', 1, NULL, 'a note', 'user', ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO chunks (id, kind, scope, owner_id, key, seq, text)
       VALUES (1, 'file', 'global', NULL, 'f1', 0, 'keep'),
              (2, 'note', 'global', NULL, 'n1', 0, 'a note')`,
    ).run();
    db.prepare(
      `INSERT INTO chunk_vectors (chunk_id, model, embedding)
       VALUES (1, 'm', X'00'), (2, 'm', X'00')`,
    ).run();

    const grant = JSON.stringify({
      mode: "allow",
      groups: ["files", "memory"],
      except: ["memory_delete", "files_delete"],
      extras: ["memory_search", "web_search"],
      known: ["files_list", "memory_add", "memory_move"],
    });
    const approval = JSON.stringify({ memory_add: true, files_write: false });
    db.prepare(
      `INSERT INTO agents (id, name, prompt, version, created_at, updated_at, tool_grant, tool_approval)
       VALUES ('a1', 'A', 'p', 1, ?, ?, ?, ?)`,
    ).run(NOW, NOW, grant, approval);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, seq, name, description, prompt, created_at, tool_grant, tool_approval)
       VALUES ('a1', 1, 'A', '', 'p', ?, ?, ?)`,
    ).run(NOW, grant, approval);

    const settings = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    );
    settings.run(
      "toolApproval",
      JSON.stringify({
        memory_add: { ask: false },
        files_write: { ask: true },
      }),
    );
    settings.run(
      "toolAlwaysOn",
      JSON.stringify({ memory_add: true, files_write: false }),
    );
    settings.run("toolsOff", JSON.stringify(["memory_list", "web_search"]));

    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', ?)",
    ).run(NOW);
    db.prepare(
      `INSERT INTO session_tool_approvals (session_id, tool_name, created_at)
       VALUES ('s', 'memory_add', ?), ('s', 'files_write', ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO tool_subject_grants (tool, subject_kind, subject_id, created_at)
       VALUES ('memory_add', 'workspace', 'w', ?), ('files_write', 'workspace', 'w', ?)`,
    ).run(NOW, NOW);

    migrate(db, all.filter(THROUGH_33));
    return db;
  }

  const rows = (sql: string) => db.prepare(sql).all();
  const setting = (key: string) =>
    JSON.parse(
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as {
          value: string;
        }
      ).value,
    ) as unknown;

  it("deletes notes with their versions, chunks, vectors and search entries", () => {
    seeded();
    expect(rows("SELECT id, kind FROM entries")).toEqual([
      { id: "e1", kind: "file" },
    ]);
    expect(rows("SELECT entry_id FROM entry_versions")).toEqual([
      { entry_id: "e1" },
    ]);
    expect(rows("SELECT id, kind FROM chunks")).toEqual([
      { id: 1, kind: "file" },
    ]);
    expect(rows("SELECT chunk_id FROM chunk_vectors")).toEqual([
      { chunk_id: 1 },
    ]);
    expect(
      rows("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'note'"),
    ).toEqual([]);
    expect(
      rows("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'keep'"),
    ).toEqual([{ rowid: 1 }]);
  });

  it("takes memory out of every agent's grant and approval settings, and each version's", () => {
    seeded();
    const expected = {
      mode: "allow",
      groups: ["files"],
      except: ["files_delete"],
      extras: ["web_search"],
      known: ["files_list"],
    };
    const grants = (
      rows(
        `SELECT tool_grant, tool_approval FROM agents WHERE id = 'a1'
         UNION ALL SELECT tool_grant, tool_approval FROM agent_versions WHERE agent_id = 'a1'`,
      ) as { tool_grant: string; tool_approval: string }[]
    ).map((r) => ({
      grant: JSON.parse(r.tool_grant) as unknown,
      approval: JSON.parse(r.tool_approval) as unknown,
    }));
    expect(grants).toEqual([
      { grant: expected, approval: { files_write: false } },
      { grant: expected, approval: { files_write: false } },
    ]);
  });

  it("cleans the per-tool settings, keeping booleans as booleans", () => {
    seeded();
    expect(setting("toolApproval")).toEqual({ files_write: { ask: true } });
    expect(setting("toolAlwaysOn")).toEqual({ files_write: false });
    expect(setting("toolsOff")).toEqual(["web_search"]);
  });

  it("removes session approvals and subject grants for the memory tools", () => {
    seeded();
    expect(rows("SELECT tool_name FROM session_tool_approvals")).toEqual([
      { tool_name: "files_write" },
    ]);
    expect(rows("SELECT tool FROM tool_subject_grants")).toEqual([
      { tool: "files_write" },
    ]);
  });

  it("changes the built-in schemas and data skill, and its current version", () => {
    seeded();
    const text = (
      rows(
        `SELECT body FROM skills WHERE id = 'builtin-schemas-and-data'
         UNION ALL SELECT body FROM skill_versions WHERE skill_id = 'builtin-schemas-and-data'`,
      ) as { body: string }[]
    ).map((r) => r.body);
    expect(text).toHaveLength(2);
    for (const body of text) {
      expect(body).toContain("Use files for writing kept for the user.");
      expect(body).not.toContain("memory");
    }
  });

  it("works when there is nothing to remove", () => {
    db = new Database(":memory:");
    migrate(db, loadMigrations(MIGRATIONS_DIR).filter(THROUGH_33));
    expect(rows("SELECT count(*) AS n FROM entries")).toEqual([{ n: 0 }]);
  });
});

describe("removeMemoryFromHistory", () => {
  function setup() {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, loadMigrations(MIGRATIONS_DIR).filter(THROUGH_33));
    for (const id of ["s", "s2", "s3"]) {
      db.prepare(
        "INSERT INTO sessions (id, title, created_at) VALUES (?, 't', ?)",
      ).run(id, NOW);
    }
    return db;
  }

  let seq = 0;
  function add(
    session: string,
    id: string,
    message: unknown,
    parent: string | null,
    extra: { anchor?: string } = {},
  ) {
    db.prepare(
      `INSERT INTO messages (id, session_id, seq, message, created_at, parent_id, anchor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session,
      ++seq,
      JSON.stringify(message),
      NOW,
      parent,
      extra.anchor ?? null,
    );
  }
  const read = (id: string) =>
    JSON.parse(
      (
        db.prepare("SELECT message FROM messages WHERE id = ?").get(id) as {
          message: string;
        }
      ).message,
    ) as Record<string, unknown>;
  const ids = (session: string) =>
    (
      db
        .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY seq")
        .all(session) as { id: string }[]
    ).map((r) => r.id);
  const parent = (id: string) =>
    (
      db.prepare("SELECT parent_id FROM messages WHERE id = ?").get(id) as {
        parent_id: string | null;
      }
    ).parent_id;

  const call = (id: string, name: string) => ({
    type: "tool_call",
    callId: id,
    name,
    arguments: "{}",
  });
  const result = (callId: string, name: string, entries?: unknown[]) => ({
    role: "tool",
    callId,
    name,
    content: "{}",
    isError: false,
    ...(entries ? { entries } : {}),
  });
  const filePut = { op: "put", kind: "file", key: "a", value: "1" };
  const notePut = { op: "put", kind: "note", key: "n1", value: "fact" };

  it("drops memory calls, results and note changes, and keeps the line joined", () => {
    setup();
    add("s", "u1", { role: "user", content: "hi" }, null);
    add(
      "s",
      "a1",
      { role: "assistant", content: [call("c1", "memory_add")] },
      "u1",
    );
    add("s", "t1", result("c1", "memory_add", [notePut]), "a1");
    add(
      "s",
      "a2",
      {
        role: "assistant",
        content: [
          { type: "text", text: "Saving" },
          call("c2", "files_write"),
          call("c3", "memory_search"),
        ],
      },
      "t1",
    );
    add("s", "t2", result("c2", "files_write", [filePut, notePut]), "a2");
    add("s", "t3", result("c3", "memory_search"), "t2");
    add(
      "s",
      "a3",
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      "t3",
    );
    add(
      "s",
      "e1",
      { role: "edit", content: "[note]", entries: [notePut] },
      "a3",
    );
    add("s", "u2", { role: "user", content: "next" }, "e1");
    db.prepare(
      "UPDATE messages SET last_child_id = 't1' WHERE id = 'a1'",
    ).run();
    db.prepare(
      "UPDATE sessions SET tip_id = 'u2', seen_tip_id = 'e1' WHERE id = 's'",
    ).run();
    db.prepare(
      "INSERT INTO runs (id, session_id, kind, status, started_at) VALUES ('r', 's', 'user', 'finished', ?)",
    ).run(NOW);
    db.prepare(
      `INSERT INTO run_messages (run_id, message_id, seq)
       VALUES ('r', 'a1', 1), ('r', 't1', 2), ('r', 'a2', 3)`,
    ).run();

    expect(removeMemoryFromHistory(db)).toBe(6);

    expect(ids("s")).toEqual(["u1", "a2", "t2", "a3", "u2"]);
    expect(parent("a2")).toBe("u1");
    expect(parent("t2")).toBe("a2");
    expect(parent("a3")).toBe("t2");
    expect(parent("u2")).toBe("a3");
    expect(read("a2")["content"]).toEqual([
      { type: "text", text: "Saving" },
      call("c2", "files_write"),
    ]);
    expect(read("t2")["entries"]).toEqual([filePut]);
    expect(
      db
        .prepare("SELECT tip_id, seen_tip_id FROM sessions WHERE id = 's'")
        .get(),
    ).toEqual({ tip_id: "u2", seen_tip_id: "a3" });
    expect(
      db.prepare("SELECT last_child_id FROM messages WHERE id = 'u1'").get(),
    ).toEqual({ last_child_id: null });
    expect(db.prepare("SELECT message_id FROM run_messages").all()).toEqual([
      { message_id: "a2" },
    ]);
  });

  it("moves the session's tip when the last message goes", () => {
    setup();
    add("s", "u1", { role: "user", content: "hi" }, null);
    add(
      "s",
      "a1",
      { role: "assistant", content: [call("c1", "memory_list")] },
      "u1",
    );
    add("s", "t1", result("c1", "memory_list"), "a1");
    db.prepare("UPDATE sessions SET tip_id = 't1' WHERE id = 's'").run();

    removeMemoryFromHistory(db);

    expect(ids("s")).toEqual(["u1"]);
    expect(
      db.prepare("SELECT tip_id FROM sessions WHERE id = 's'").get(),
    ).toEqual({ tip_id: "u1" });
  });

  it("keeps every branch: all children of a deleted message move up", () => {
    setup();
    add("s", "u1", { role: "user", content: "hi" }, null);
    add(
      "s",
      "a1",
      { role: "assistant", content: [call("c1", "memory_add")] },
      "u1",
    );
    add("s", "t1", result("c1", "memory_add"), "a1");
    add("s", "b1", { role: "user", content: "one" }, "t1");
    add("s", "b2", { role: "user", content: "two" }, "t1");

    removeMemoryFromHistory(db);

    expect(parent("b1")).toBe("u1");
    expect(parent("b2")).toBe("u1");
  });

  it("rewrites an edit message that also changed a file, and keeps data edits", () => {
    setup();
    add(
      "s2",
      "e1",
      {
        role: "edit",
        content: "[old]",
        entries: [{ op: "put", kind: "file", key: "a", value: "x" }, notePut],
      },
      null,
    );
    add(
      "s2",
      "e2",
      {
        role: "edit",
        content: "[data edit]",
        entries: [],
        dataOps: [{ op: "x" }],
      },
      "e1",
    );

    removeMemoryFromHistory(db);

    expect(read("e1")).toEqual({
      role: "edit",
      content: "[The user changed session file a in the app.]",
      entries: [{ op: "put", kind: "file", key: "a", value: "x" }],
    });
    expect(read("e2")["content"]).toBe("[data edit]");
  });

  it("keeps an empty assistant message that a subagent run is anchored to", () => {
    setup();
    add("s3", "u1", { role: "user", content: "hi" }, null);
    add(
      "s3",
      "a1",
      { role: "assistant", content: [call("c1", "memory_add")] },
      "u1",
    );
    add("s3", "sub", { role: "assistant", content: [] }, null, {
      anchor: "a1",
    });

    removeMemoryFromHistory(db);

    expect(ids("s3")).toEqual(["u1", "a1", "sub"]);
    expect(read("a1")["content"]).toEqual([]);
  });

  it("changes nothing the second time", () => {
    setup();
    add("s", "u1", { role: "user", content: "hi" }, null);
    add(
      "s",
      "a1",
      { role: "assistant", content: [call("c1", "memory_add")] },
      "u1",
    );
    add("s", "t1", result("c1", "memory_add", [notePut]), "a1");
    expect(removeMemoryFromHistory(db)).toBeGreaterThan(0);
    expect(removeMemoryFromHistory(db)).toBe(0);
  });
});
