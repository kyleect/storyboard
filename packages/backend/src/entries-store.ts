import type { Database } from "better-sqlite3-multiple-ciphers";
import type { SearchIndex } from "./search-index.js";
import type {
  EntryAuthor,
  EntryKind,
  FileType,
  SharedEntries,
  SharedScope,
} from "@harness/core";

/*
 * Project and global files and memory notes, with their versions (files and
 * memory design, decisions 8 and 11). A project id of null means global.
 * Purging a project or session handles these tables in `Store`.
 */

export interface EntryRow {
  id: string;
  kind: EntryKind;
  project_id: string | null;
  key: string;
  type: FileType | null;
  value: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VersionRow {
  seq: number;
  type: FileType | null;
  value: string;
  deleted: number;
  author: "user" | "model";
  session_id: string | null;
  run_id: string | null;
  created_at: string;
}

const COLUMNS =
  "id, kind, project_id, key, type, value, created_at, updated_at, deleted_at";

export class EntryStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** Kept in step with every change, when given. */
    private readonly index?: SearchIndex,
  ) {}

  private reindex(
    kind: EntryKind,
    projectId: string | null,
    key: string,
    value: string | null,
  ) {
    this.index?.indexEntry(
      kind,
      projectId === null ? "global" : "project",
      projectId,
      key,
      value,
    );
  }

  /** Includes deleted entries only when asked. Ordered by key. */
  list(
    kind: EntryKind,
    projectId: string | null,
    includeDeleted = false,
  ): EntryRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM entries
         WHERE kind = ? AND project_id IS ? AND (? OR deleted_at IS NULL)
         ORDER BY key`,
      )
      .all(kind, projectId, includeDeleted ? 1 : 0) as EntryRow[];
  }

  /** Includes a deleted entry. */
  get(
    kind: EntryKind,
    projectId: string | null,
    key: string,
  ): EntryRow | undefined {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM entries
         WHERE kind = ? AND project_id IS ? AND key = ?`,
      )
      .get(kind, projectId, key) as EntryRow | undefined;
  }

  /** Creates, replaces or restores the entry, and records a version. */
  put(
    kind: EntryKind,
    projectId: string | null,
    entry: { key: string; value: string; type?: FileType },
    author: EntryAuthor,
  ): EntryRow {
    return this.db.transaction(() => {
      const now = this.now();
      const type = kind === "file" ? (entry.type ?? "plain") : null;
      const existing = this.get(kind, projectId, entry.key);
      const id = existing?.id ?? this.newId();
      if (existing) {
        this.db
          .prepare(
            `UPDATE entries SET type = ?, value = ?, updated_at = ?,
             deleted_at = NULL WHERE id = ?`,
          )
          .run(type, entry.value, now, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO entries (id, kind, project_id, key, type, value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, kind, projectId, entry.key, type, entry.value, now, now);
      }
      this.addVersion(id, type, entry.value, false, author, now);
      this.reindex(kind, projectId, entry.key, entry.value);
      return this.get(kind, projectId, entry.key) as EntryRow;
    })();
  }

  /** Marks the entry deleted. False when there is no such live entry. */
  delete(
    kind: EntryKind,
    projectId: string | null,
    key: string,
    author: EntryAuthor,
  ): boolean {
    return this.db.transaction(() => {
      const existing = this.get(kind, projectId, key);
      if (!existing || existing.deleted_at !== null) return false;
      const now = this.now();
      this.db
        .prepare(
          "UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, existing.id);
      this.addVersion(
        existing.id,
        existing.type,
        existing.value,
        true,
        author,
        now,
      );
      this.reindex(kind, projectId, key, null);
      return true;
    })();
  }

  /** Oldest first. Empty when the entry does not exist. */
  versions(
    kind: EntryKind,
    projectId: string | null,
    key: string,
  ): VersionRow[] {
    const entry = this.get(kind, projectId, key);
    if (!entry) return [];
    return this.db
      .prepare(
        `SELECT seq, type, value, deleted, author, session_id, run_id, created_at
         FROM entry_versions WHERE entry_id = ? ORDER BY seq`,
      )
      .all(entry.id) as VersionRow[];
  }

  private addVersion(
    entryId: string,
    type: FileType | null,
    value: string,
    deleted: boolean,
    author: EntryAuthor,
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO entry_versions
           (entry_id, seq, type, value, deleted, author, session_id, run_id, created_at)
         VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM entry_versions WHERE entry_id = ?),
                 ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        entryId,
        type,
        value,
        deleted ? 1 : 0,
        author.by,
        author.sessionId ?? null,
        author.by === "model" ? author.runId : null,
        now,
      );
  }

  /** The `SharedEntries` tools use in a session of this project (or none). */
  shared(projectId: string | null): SharedEntries {
    const pid = (scope: SharedScope): string | null => {
      if (scope === "global") return null;
      if (projectId === null) {
        throw new Error("This session is not in a project.");
      }
      return projectId;
    };
    const toShared = (r: EntryRow) => ({
      key: r.key,
      value: r.value,
      ...(r.type ? { type: r.type } : {}),
      updatedAt: r.updated_at,
    });
    return {
      list: (kind, scope) => this.list(kind, pid(scope)).map(toShared),
      get: (kind, scope, key) => {
        const row = this.get(kind, pid(scope), key);
        return row && row.deleted_at === null ? toShared(row) : undefined;
      },
      exists: (kind, scope, key) =>
        this.get(kind, pid(scope), key) !== undefined,
      put: (kind, scope, entry, author) => {
        this.put(kind, pid(scope), entry, author);
      },
      delete: (kind, scope, key, author) =>
        this.delete(kind, pid(scope), key, author),
    };
  }
}
