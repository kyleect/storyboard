import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3-multiple-ciphers";
import { loadOrCreateKey, openDatabase } from "./db.js";
import { loadMigrations, migrate } from "./migrate.js";

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
