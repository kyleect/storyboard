import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";

/*
 * Encrypted SQLite (design doc 6.12, 6.13).
 *
 * - Driver: better-sqlite3-multiple-ciphers in SQLCipher-compatible mode
 *   (cipher=sqlcipher, legacy=4), readable by the stock sqlcipher tool.
 * - Key: a random 256-bit value stored as 64 hex characters in an
 *   owner-only key file. It is passed to SQLCipher as the key passphrase.
 */

export class KeyError extends Error {
  override name = "KeyError";
}

/**
 * Reads the key file, or creates it when neither it nor the database exists.
 * Refuses to start when the database exists but the key file does not.
 */
export function loadOrCreateKey(keyFile: string, dbPath: string): string {
  if (existsSync(keyFile)) {
    const mode = statSync(keyFile).mode & 0o777;
    if (mode & 0o077) {
      throw new KeyError(
        `Key file ${keyFile} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${keyFile}"`,
      );
    }
    const key = readFileSync(keyFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new KeyError(
        `Key file ${keyFile} does not contain a 64-character hex key.`,
      );
    }
    return key;
  }
  if (existsSync(dbPath)) {
    throw new KeyError(
      `The database ${dbPath} exists but its key file ${keyFile} is missing. Without the key the database cannot be opened. Restore the key file or set HARNESS_KEY_FILE.`,
    );
  }
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyFile, key + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(keyFile, 0o600);
  return key;
}

export function openDatabase(path: string, key: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(`key='${key}'`);
    // Fails here, not later, if the key is wrong.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_NOTADB") {
      throw new KeyError(
        `Cannot open ${path}: the key is wrong or the file is not an encrypted database.`,
      );
    }
    throw err;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
