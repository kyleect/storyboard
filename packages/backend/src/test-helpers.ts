import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3-multiple-ciphers";
import { loadOrCreateKey, openDatabase } from "./db.js";
import { loadMigrations, migrate } from "./migrate.js";
import type { ToolGrant, ToolMode } from "./tool-grants.js";

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** A fresh encrypted, migrated database in a temporary folder. */
export interface TempDatabase {
  dir: string;
  dbPath: string;
  keyFile: string;
  key: string;
  db: Database;
  cleanup: () => void;
}

export function tempDatabase(): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  const dbPath = join(dir, "test.db");
  const keyFile = join(dir, "test.key");
  const key = loadOrCreateKey(keyFile, dbPath);
  const db = openDatabase(dbPath, key);
  migrate(db, loadMigrations(MIGRATIONS_DIR));
  return {
    dir,
    dbPath,
    keyFile,
    key,
    db,
    cleanup: () => {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Waits for a run to end, answering each form it shows with the next of
 * `answers` (tool prompts design). Fails when a form is left without an
 * answer, or the run takes longer than `timeoutMs`.
 */
export async function runAnsweringForms(
  runs: {
    isActive(runId: string): boolean;
    snapshot(sessionId: string): {
      activeRun: { inputs: { requestId: string }[] } | null;
    };
    answerInput(
      runId: string,
      requestId: string,
      answer: { outcome: "answered"; answers: Record<string, unknown> },
    ): void;
  },
  sessionId: string,
  runId: string,
  answers: Record<string, unknown>[],
  timeoutMs = 5000,
): Promise<void> {
  const queue = [...answers];
  const deadline = Date.now() + timeoutMs;
  while (runs.isActive(runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end in time.");
    const open = runs.snapshot(sessionId).activeRun?.inputs[0];
    if (open) {
      const next = queue.shift();
      if (!next) throw new Error("The run showed a form with no answer left.");
      runs.answerInput(runId, open.requestId, {
        outcome: "answered",
        answers: next,
      });
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Removes the built-in skills and schemas the migrations add (schemas and
 * data design, decisions 45 to 52), for tests about something else that
 * count what is in scope.
 */
export function clearBuiltins(db: Database): void {
  clearBuiltinAgents(db);
  db.exec(`
    DELETE FROM skill_files WHERE skill_id IN (SELECT id FROM skills WHERE builtin = 1);
    DELETE FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE builtin = 1);
    DELETE FROM skills WHERE builtin = 1;
    DELETE FROM schema_versions WHERE schema_id IN (SELECT id FROM schemas WHERE builtin = 1);
    DELETE FROM schemas WHERE builtin = 1;
  `);
}

/**
 * Removes the built-in Dispatcher agent (agent delegation design, section 9),
 * for tests where a new session should start with no agent.
 */
export function clearBuiltinAgents(db: Database): void {
  db.exec(`
    DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE builtin = 1);
    DELETE FROM agents WHERE builtin = 1;
  `);
}

/**
 * A tool grant made of single tools, the way a plain list of names used to
 * be: `grant("allow", ["a"])` allows only `a`; `grant("deny", ["a"])` allows
 * every tool but `a`. `known` is empty unless given.
 */
export function grant(
  mode: ToolMode,
  tools: string[] = [],
  known: string[] = [],
): ToolGrant {
  return { mode, groups: [], except: [], extras: tools, known };
}
