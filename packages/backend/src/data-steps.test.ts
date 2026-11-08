import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileOpsToMediaTypes,
  rewriteMessages,
  runDataSteps,
  type DataStep,
} from "./data-steps.js";
import { loadMigrations, migrate } from "./migrate.js";
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
    ]);
    expect(read("m1").entries).toEqual([
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
      { name: "file-ops-media-types", done_at: "T" },
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
