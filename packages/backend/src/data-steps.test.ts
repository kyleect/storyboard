import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchesBackfill,
  fileOpsToMediaTypes,
  rewriteMessages,
  runDataSteps,
  type DataStep,
} from "./data-steps.js";
import { loadMigrations, migrate } from "./migrate.js";
import { Store } from "./store.js";
import { MIGRATIONS_DIR } from "./test-helpers.js";

let db: Database.Database;
afterEach(() => {
  if (db?.open) db.close();
});

function setup() {
  db = new Database(":memory:");
  migrate(db, loadMigrations(MIGRATIONS_DIR));
  db.prepare(
    "INSERT INTO sessions (id, title, created_at) VALUES ('s', 't', 't')",
  ).run();
  return db;
}

function addMessage(id: string, message: unknown, seq: number) {
  db.prepare(
    "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES (?, 's', ?, ?, 't')",
  ).run(id, seq, JSON.stringify(message));
}

const read = (id: string) =>
  JSON.parse(
    (
      db.prepare("SELECT message FROM messages WHERE id = ?").get(id) as {
        message: string;
      }
    ).message,
  );

describe("fileOpsToMediaTypes", () => {
  it("renames type to mediaType on put ops only", () => {
    const m = {
      role: "tool",
      entries: [
        { op: "put", key: "a", type: "markdown", value: "x" },
        { op: "delete", key: "b" },
      ],
    };
    expect(fileOpsToMediaTypes(m)).toBe(true);
    expect(m.entries).toEqual([
      { op: "put", key: "a", mediaType: "text/markdown", value: "x" },
      { op: "delete", key: "b" },
    ]);
  });

  it("leaves messages without file ops alone", () => {
    expect(fileOpsToMediaTypes({ role: "user", content: "hi" })).toBe(false);
    expect(
      fileOpsToMediaTypes({
        entries: [{ op: "put", key: "a", mediaType: "text/plain", value: "" }],
      }),
    ).toBe(false);
  });
});

describe("runDataSteps", () => {
  it("rewrites old messages once and changes nothing the second time", () => {
    setup();
    addMessage(
      "m1",
      {
        role: "tool",
        entries: [{ op: "put", key: "a", type: "json", value: "{}" }],
      },
      1,
    );
    addMessage("m2", { role: "user", content: "hello" }, 2);
    const before2 = (
      db.prepare("SELECT message FROM messages WHERE id = 'm2'").get() as {
        message: string;
      }
    ).message;

    expect(runDataSteps(db, undefined, () => "T")).toEqual([
      { name: "file-ops-media-types", changed: 1 },
      { name: "attachments-to-files", changed: 0 },
      // Two top-level messages, chained into one line.
      { name: "branches-backfill", changed: 2 },
      { name: "memory-removal", changed: 0 },
      // The tool result with changes: `entries` becomes `files`.
      { name: "files-rename", changed: 1 },
      { name: "decision-comment-rename", changed: 0 },
      // The four built-in skills' versions become folders.
      { name: "skills-to-folders", changed: 4 },
    ]);
    expect(read("m1").files).toEqual([
      { op: "put", key: "a", mediaType: "application/json", value: "{}" },
    ]);
    expect(
      (
        db.prepare("SELECT message FROM messages WHERE id = 'm2'").get() as {
          message: string;
        }
      ).message,
    ).toBe(before2);
    expect(db.prepare("SELECT * FROM data_steps ORDER BY name").all()).toEqual([
      { name: "attachments-to-files", done_at: "T" },
      { name: "branches-backfill", done_at: "T" },
      { name: "decision-comment-rename", done_at: "T" },
      { name: "file-ops-media-types", done_at: "T" },
      { name: "files-rename", done_at: "T" },
      { name: "memory-removal", done_at: "T" },
      { name: "skills-to-folders", done_at: "T" },
    ]);

    expect(runDataSteps(db)).toEqual([]);
  });

  it("rolls a failing step back and leaves it not done", () => {
    setup();
    addMessage("m1", { role: "user", content: "a" }, 1);
    const bad: DataStep = {
      name: "bad",
      run: (d) => {
        rewriteMessages(d, (m) => {
          m["content"] = "changed";
          return true;
        });
        throw new Error("boom");
      },
    };
    expect(() => runDataSteps(db, [bad])).toThrow(/boom/);
    expect(read("m1").content).toBe("a");
    expect(db.prepare("SELECT * FROM data_steps").all()).toEqual([]);
  });
});

describe("branchesBackfill", () => {
  const call = (callId: string) => ({
    role: "assistant",
    content: [
      { type: "tool_call", callId, name: "start_subagent", arguments: {} },
    ],
  });
  const user = (content: string) => ({ role: "user", content });
  const tool = (callId: string) => ({
    role: "tool",
    callId,
    name: "x",
    content: "ok",
    isError: false,
  });
  const row = (id: string) =>
    db
      .prepare(
        "SELECT parent_id, anchor_id, last_child_id FROM messages WHERE id = ?",
      )
      .get(id);
  const tip = (session = "s") =>
    (
      db.prepare("SELECT tip_id FROM sessions WHERE id = ?").get(session) as {
        tip_id: string | null;
      }
    ).tip_id;

  it("chains a linear session into one line with the last message as its tip", () => {
    setup();
    addMessage("m1", user("a"), 1);
    addMessage("m2", { role: "assistant", content: [] }, 2);
    addMessage("m3", user("b"), 3);
    expect(branchesBackfill(db)).toBe(3);
    expect(row("m1")).toEqual({
      parent_id: null,
      anchor_id: null,
      last_child_id: "m2",
    });
    expect(row("m2")).toEqual({
      parent_id: "m1",
      anchor_id: null,
      last_child_id: "m3",
    });
    expect(row("m3")).toEqual({
      parent_id: "m2",
      anchor_id: null,
      last_child_id: null,
    });
    expect(tip()).toBe("m3");
  });

  it("leaves a session with no messages without a tip", () => {
    setup();
    expect(branchesBackfill(db)).toBe(0);
    expect(tip()).toBeNull();
  });

  it("anchors subagent messages to the message holding the root call, at any depth", () => {
    setup();
    const store = new Store(db);
    addMessage("u1", user("go"), 1);
    addMessage("a1", call("c1"), 2);
    addMessage("c-task", user("task"), 3);
    addMessage("c-call", call("c2"), 4);
    addMessage("cc-task", user("inner task"), 5);
    addMessage("t1", tool("c1"), 6);
    store.createRun({ id: "r1", sessionId: "s", kind: "chat", now: "T1" });
    for (const m of ["u1", "a1", "t1"]) store.linkRunMessage("r1", m);
    store.createRun({
      id: "r2",
      sessionId: "s",
      kind: "chat",
      now: "T2",
      parent: { runId: "r1", callId: "c1" },
    });
    for (const m of ["c-task", "c-call"]) store.linkRunMessage("r2", m);
    store.createRun({
      id: "r3",
      sessionId: "s",
      kind: "chat",
      now: "T3",
      parent: { runId: "r2", callId: "c2" },
    });
    store.linkRunMessage("r3", "cc-task");

    branchesBackfill(db);
    // The line holds the top-level messages only.
    expect(row("u1")).toMatchObject({ parent_id: null, last_child_id: "a1" });
    expect(row("a1")).toMatchObject({ parent_id: "u1", last_child_id: "t1" });
    expect(row("t1")).toMatchObject({ parent_id: "a1" });
    expect(tip()).toBe("t1");
    for (const id of ["c-task", "c-call", "cc-task"]) {
      expect(row(id)).toEqual({
        parent_id: null,
        anchor_id: "a1",
        last_child_id: null,
      });
    }
    // The old reading of the session is the new one.
    expect(store.listMessages("s").map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "c-task",
      "c-call",
      "cc-task",
      "t1",
    ]);
    expect(store.listMessages("s", "top").map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "t1",
    ]);
  });

  it("anchors to the nearest earlier top-level message when the call's message is missing", () => {
    setup();
    const store = new Store(db);
    addMessage("u1", user("go"), 1);
    addMessage("a1", { role: "assistant", content: [] }, 2);
    addMessage("orphan", user("task"), 3);
    addMessage("u2", user("next"), 4);
    store.createRun({ id: "r1", sessionId: "s", kind: "chat", now: "T1" });
    store.linkRunMessage("r1", "a1");
    store.createRun({
      id: "r2",
      sessionId: "s",
      kind: "chat",
      now: "T2",
      parent: { runId: "r1", callId: "never-saved" },
    });
    store.linkRunMessage("r2", "orphan");
    branchesBackfill(db);
    expect(row("orphan")).toMatchObject({ anchor_id: "a1", parent_id: null });
    expect(store.listMessages("s").map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "orphan",
      "u2",
    ]);
  });

  it("runs once as a data step, and the second start changes nothing", () => {
    setup();
    addMessage("m1", user("a"), 1);
    addMessage("m2", user("b"), 2);
    const ran = runDataSteps(db, undefined, () => "T");
    expect(ran.find((r) => r.name === "branches-backfill")?.changed).toBe(2);
    db.prepare("UPDATE messages SET parent_id = NULL").run();
    expect(runDataSteps(db)).toEqual([]);
    expect(row("m2")).toMatchObject({ parent_id: null });
  });
});
