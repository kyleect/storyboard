import type { Database } from "better-sqlite3-multiple-ciphers";
import type { SearchIndex } from "./search-index.js";
import { isInFolder } from "@harness/core";
import { sweepBlobs } from "./blobs.js";
import { getDerived, indexedText } from "./media-describer.js";
import type {
  BlobRef,
  EntryAuthor,
  EntryKind,
  MediaType,
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
  media_type: MediaType | null;
  value: string;
  /** Binary files: where the bytes are kept (`value` is empty). */
  blob_hash: string | null;
  size: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** How many versions of a binary file are kept (D12). */
export const BINARY_VERSIONS_KEPT = 3;

export interface VersionRow {
  seq: number;
  media_type: MediaType | null;
  value: string;
  blob_hash: string | null;
  size: number | null;
  deleted: number;
  author: "user" | "model";
  session_id: string | null;
  run_id: string | null;
  created_at: string;
}

const COLUMNS =
  "id, kind, project_id, key, media_type, value, blob_hash, size, created_at, updated_at, deleted_at";

/** The blob a row or version points at, as the core types carry it. */
export const blobOf = (row: {
  blob_hash: string | null;
  size: number | null;
}): BlobRef | undefined =>
  row.blob_hash !== null
    ? { hash: row.blob_hash, size: row.size ?? 0 }
    : undefined;

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
    entry: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
    author: EntryAuthor,
  ): EntryRow {
    return this.db.transaction(() => {
      const now = this.now();
      const type = kind === "file" ? (entry.mediaType ?? "text/plain") : null;
      const hash = entry.blob?.hash ?? null;
      const size = entry.blob?.size ?? null;
      const existing = this.get(kind, projectId, entry.key);
      const id = existing?.id ?? this.newId();
      if (existing) {
        this.db
          .prepare(
            `UPDATE entries SET media_type = ?, value = ?, blob_hash = ?, size = ?,
             updated_at = ?, deleted_at = NULL WHERE id = ?`,
          )
          .run(type, entry.value, hash, size, now, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO entries (id, kind, project_id, key, media_type, value, blob_hash, size, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            kind,
            projectId,
            entry.key,
            type,
            entry.value,
            hash,
            size,
            now,
            now,
          );
      }
      this.addVersion(id, type, entry.value, entry.blob, false, author, now);
      // A binary file is found by its derived text, when it has one.
      this.reindex(
        kind,
        projectId,
        entry.key,
        entry.blob
          ? indexedText(getDerived(this.db, entry.blob.hash))
          : entry.value,
      );
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
        existing.media_type,
        existing.value,
        blobOf(existing),
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
        `SELECT seq, media_type, value, blob_hash, size, deleted, author, session_id, run_id, created_at
         FROM entry_versions WHERE entry_id = ? ORDER BY seq`,
      )
      .all(entry.id) as VersionRow[];
  }

  private addVersion(
    entryId: string,
    type: MediaType | null,
    value: string,
    blob: BlobRef | undefined,
    deleted: boolean,
    author: EntryAuthor,
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO entry_versions
           (entry_id, seq, media_type, value, blob_hash, size, deleted, author, session_id, run_id, created_at)
         VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM entry_versions WHERE entry_id = ?),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        entryId,
        type,
        value,
        blob?.hash ?? null,
        blob?.size ?? null,
        deleted ? 1 : 0,
        author.by,
        author.sessionId ?? null,
        author.by === "model" ? author.runId : null,
        now,
      );
    if (blob) this.pruneBinaryVersions(entryId);
  }

  /**
   * A binary file keeps its last `BINARY_VERSIONS_KEPT` versions (D12). The
   * older ones are deleted, and their bytes with them when nothing else
   * points at them.
   */
  private pruneBinaryVersions(entryId: string) {
    const removed = this.db
      .prepare(
        `DELETE FROM entry_versions
         WHERE entry_id = ? AND blob_hash IS NOT NULL AND seq NOT IN (
           SELECT seq FROM entry_versions
           WHERE entry_id = ? AND blob_hash IS NOT NULL
           ORDER BY seq DESC LIMIT ?)`,
      )
      .run(entryId, entryId, BINARY_VERSIONS_KEPT).changes;
    if (removed > 0) sweepBlobs(this.db);
  }

  /** The explicit folders of a scope, ordered by path. */
  listFolders(projectId: string | null): string[] {
    return (
      this.db
        .prepare("SELECT path FROM folders WHERE project_id IS ? ORDER BY path")
        .all(projectId) as { path: string }[]
    ).map((r) => r.path);
  }

  createFolder(projectId: string | null, path: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO folders (project_id, path, created_at) VALUES (?, ?, ?)",
      )
      .run(projectId, path, this.now());
  }

  /** Moves the folder's rows, its explicit subfolders and its live files. */
  renameFolder(
    projectId: string | null,
    from: string,
    to: string,
    author: EntryAuthor,
  ) {
    this.db.transaction(() => {
      const rename = (path: string) => `${to}${path.slice(from.length)}`;
      for (const row of this.list("file", projectId)) {
        if (!isInFolder(row.key, from)) continue;
        this.put(
          "file",
          projectId,
          {
            key: rename(row.key),
            value: row.value,
            ...(row.media_type ? { mediaType: row.media_type } : {}),
            ...(blobOf(row) ? { blob: blobOf(row) as BlobRef } : {}),
          },
          author,
        );
        this.delete("file", projectId, row.key, author);
      }
      for (const path of this.listFolders(projectId)) {
        if (!isInFolder(path, from)) continue;
        this.db
          .prepare("DELETE FROM folders WHERE project_id IS ? AND path = ?")
          .run(projectId, path);
        this.createFolder(projectId, rename(path));
      }
      // A folder that only held files gets a row, so it still exists empty.
      this.createFolder(projectId, to);
    })();
  }

  /** Deletes the folder's rows and soft-deletes its live files. */
  deleteFolder(projectId: string | null, path: string, author: EntryAuthor) {
    this.db.transaction(() => {
      for (const row of this.list("file", projectId)) {
        if (isInFolder(row.key, path)) {
          this.delete("file", projectId, row.key, author);
        }
      }
      for (const f of this.listFolders(projectId)) {
        if (isInFolder(f, path)) {
          this.db
            .prepare("DELETE FROM folders WHERE project_id IS ? AND path = ?")
            .run(projectId, f);
        }
      }
    })();
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
      ...(r.media_type ? { mediaType: r.media_type } : {}),
      ...(blobOf(r) ? { blob: blobOf(r) as BlobRef } : {}),
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
      listFolders: (scope) => this.listFolders(pid(scope)),
      createFolder: (scope, path) => {
        this.createFolder(pid(scope), path);
      },
      renameFolder: (scope, from, to, author) => {
        this.renameFolder(pid(scope), from, to, author);
      },
      deleteFolder: (scope, path, author) => {
        this.deleteFolder(pid(scope), path, author);
      },
    };
  }
}
