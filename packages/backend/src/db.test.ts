import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyError, loadOrCreateKey, openDatabase } from "./db.js";
import { tempDir } from "./test-helpers.js";

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  return {
    dir: t.dir,
    dbPath: join(t.dir, "app.db"),
    keyFile: join(t.dir, "app.key"),
  };
}

describe("key file", () => {
  it("is created on first run, owner-only, with a 256-bit hex key", () => {
    const { dbPath, keyFile } = setup();
    const key = loadOrCreateKey(keyFile, dbPath);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKey(keyFile, dbPath)).toBe(key);
  });

  it("refuses to start when the database exists but the key is missing", () => {
    const { dbPath, keyFile } = setup();
    writeFileSync(dbPath, "");
    expect(() => loadOrCreateKey(keyFile, dbPath)).toThrow(KeyError);
    expect(() => loadOrCreateKey(keyFile, dbPath)).toThrow(
      /key file .* is missing/,
    );
  });

  it("refuses a key file other users can read", () => {
    const { dbPath, keyFile } = setup();
    loadOrCreateKey(keyFile, dbPath);
    chmodSync(keyFile, 0o644);
    expect(() => loadOrCreateKey(keyFile, dbPath)).toThrow(/chmod 600/);
  });

  it("refuses a key file with the wrong contents", () => {
    const { dbPath, keyFile } = setup();
    writeFileSync(keyFile, "not a key", { mode: 0o600 });
    expect(() => loadOrCreateKey(keyFile, dbPath)).toThrow(
      /64-character hex key/,
    );
  });
});

describe("encrypted database", () => {
  it("is not readable as plain SQLite and rejects a wrong key", () => {
    const { dbPath, keyFile } = setup();
    const key = loadOrCreateKey(keyFile, dbPath);
    const db = openDatabase(dbPath, key);
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('secret')");
    db.close();

    const header = readFileSync(dbPath).subarray(0, 16).toString("latin1");
    expect(header).not.toContain("SQLite format 3");
    expect(readFileSync(dbPath).toString("latin1")).not.toContain("secret");
    expect(() => openDatabase(dbPath, "0".repeat(64))).toThrow(KeyError);

    const reopened = openDatabase(dbPath, key);
    expect(reopened.prepare("SELECT x FROM t").get()).toEqual({ x: "secret" });
    reopened.close();
  });

  // Interoperability with the stock sqlcipher tool, when it is installed.
  const hasSqlcipher = (() => {
    try {
      execFileSync("sqlcipher", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(hasSqlcipher)(
    "can be read by the sqlcipher command-line tool",
    () => {
      const { dbPath, keyFile } = setup();
      const key = loadOrCreateKey(keyFile, dbPath);
      const db = openDatabase(dbPath, key);
      db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('from-harness')");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();

      const out = execFileSync("sqlcipher", [dbPath], {
        input: `PRAGMA key='${key}';\nSELECT x FROM t;\n`,
      }).toString();
      expect(out).toContain("from-harness");
    },
  );
});
