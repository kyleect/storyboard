import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3-multiple-ciphers";

/*
 * Hand-written migration runner (design doc, "Migrations and query layer").
 *
 * - Migrations are plain `.sql` files named `NNNN_name.sql`, applied in
 *   numeric order, each in its own transaction.
 * - Each applied migration's SHA-256 checksum is stored. A changed file stops
 *   the runner with a diagnostic; `repairMigration` accepts the change.
 * - No down migrations.
 * - The whole run holds a write lock (BEGIN IMMEDIATE per migration plus a
 *   re-check), so two processes cannot apply the same migration.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** The file it was read from, for messages. */
  file?: string;
}

const fileName = (m: { version: number; name: string; file?: string }) =>
  m.file ?? `${String(m.version).padStart(4, "0")}_${m.name}.sql`;

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

const FILE = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Reads `NNNN_name.sql` files from a folder. */
export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const match = FILE.exec(file);
    if (!match) {
      throw new MigrationError(`Badly named migration file: ${file}`, {
        file,
        expected: "NNNN_name.sql",
      });
    }
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? "",
      sql: readFileSync(join(dir, file), "utf8"),
      file,
    });
  }
  return sortAndCheck(migrations);
}

function sortAndCheck(migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && prev.version === cur.version) {
      throw new MigrationError(`Two migrations share version ${cur.version}`, {
        version: cur.version,
        names: [prev.name, cur.name],
      });
    }
  }
  return sorted;
}

function ensureHistoryTable(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export function appliedMigrations(db: Database): AppliedMigration[] {
  ensureHistoryTable(db);
  return db
    .prepare(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as AppliedMigration[];
}

/** Checks applied migrations against the files; throws on any mismatch. */
export function verifyMigrations(db: Database, migrations: Migration[]) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const applied of appliedMigrations(db)) {
    const file = byVersion.get(applied.version);
    if (!file) {
      throw new MigrationError(
        `Migration ${applied.version} (${applied.name}) is recorded in the database but its file is missing.`,
        { ...applied },
      );
    }
    const current = checksum(file.sql);
    if (current !== applied.checksum) {
      throw new MigrationError(
        [
          `Migration ${fileName(file)} has changed since it was applied.`,
          `  stored checksum:  ${applied.checksum}`,
          `  current checksum: ${current}`,
          `  applied at:       ${applied.applied_at}`,
          `If the change is intended and the database already matches it, accept it with repairMigration(${applied.version}).`,
        ].join("\n"),
        {
          version: applied.version,
          name: applied.name,
          file: fileName(file),
          storedChecksum: applied.checksum,
          currentChecksum: current,
          appliedAt: applied.applied_at,
        },
      );
    }
  }
}

/** Applies pending migrations. Returns the versions applied. */
export function migrate(
  db: Database,
  migrations: Migration[],
  now: () => string = () => new Date().toISOString(),
): number[] {
  const sorted = sortAndCheck(migrations);
  verifyMigrations(db, sorted);
  const applied: number[] = [];

  for (const m of sorted) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have applied it.
      const done = db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(m.version);
      if (!done) {
        try {
          db.exec(m.sql);
        } catch (err) {
          throw new MigrationError(
            `Migration ${fileName(m)} failed: ${(err as Error).message}. Nothing from it was applied.`,
            { version: m.version, name: m.name, cause: (err as Error).message },
          );
        }
        db.prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        ).run(m.version, m.name, checksum(m.sql), now());
        applied.push(m.version);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return applied;
}

/**
 * Accepts a changed migration file by storing its current checksum.
 * Does not re-run it. Use only when the database already matches the file.
 */
export function repairMigration(
  db: Database,
  migrations: Migration[],
  version: number,
): { previous: string; current: string } {
  const file = migrations.find((m) => m.version === version);
  if (!file)
    throw new MigrationError(`No migration file for version ${version}`, {
      version,
    });
  const row = db
    .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
    .get(version) as { checksum: string } | undefined;
  if (!row) {
    throw new MigrationError(`Migration ${version} has not been applied`, {
      version,
    });
  }
  const current = checksum(file.sql);
  db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(
    current,
    version,
  );
  return { previous: row.checksum, current };
}
