import type { Database } from "better-sqlite3-multiple-ciphers";
import type { SearchIndex } from "./search-index.js";
import { isInFolder } from "@harness/core";
import { sweepBlobs } from "./blobs.js";
import { activeProfile } from "./profiles.js";
import { getDerived, indexedText } from "./media-describer.js";
import type {
  BlobRef,
  FileAuthor,
  MediaType,
  SharedFiles,
  SharedScope,
} from "@harness/core";

/*
 * Project and global files, with their versions (files and
 * memory design, decisions 8 and 11). A project id of null means global.
 * Purging a project or session handles these tables in `Store`.
 */

export interface FileRow {
  id: string;
  project_id: string | null;
  key: string;
  media_type: MediaType;
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
  "id, project_id, key, media_type, value, blob_hash, size, created_at, updated_at, deleted_at";

/** The blob a row or version points at, as the core types carry it. */
export const blobOf = (row: {
  blob_hash: string | null;
  size: number | null;
}): BlobRef | undefined =>
  row.blob_hash !== null
    ? { hash: row.blob_hash, size: row.size ?? 0 }
    : undefined;

export class FileStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** Kept in step with every change, when given. */
    private readonly index?: SearchIndex,
  ) {}

  private reindex(projectId: string | null, key: string, value: string | null) {
    this.index?.indexFile(
      projectId === null ? "global" : "project",
      projectId,
      key,
      value,
    );
  }

  /** Includes deleted files only when asked. Ordered by key. */
  list(projectId: string | null, includeDeleted = false): FileRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM files
         WHERE profile_id = ? AND project_id IS ? AND (? OR deleted_at IS NULL)
         ORDER BY key`,
      )
      .all(
        activeProfile(this.db),
        projectId,
        includeDeleted ? 1 : 0,
      ) as FileRow[];
  }

  /** Includes a deleted file. */
  get(projectId: string | null, key: string): FileRow | undefined {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM files
         WHERE profile_id = ? AND project_id IS ? AND key = ?`,
      )
      .get(activeProfile(this.db), projectId, key) as FileRow | undefined;
  }

  /** Creates, replaces or restores the file, and records a version. */
  put(
    projectId: string | null,
    file: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
    author: FileAuthor,
  ): FileRow {
    return this.db.transaction(() => {
      const now = this.now();
      const type = file.mediaType ?? "text/plain";
      const hash = file.blob?.hash ?? null;
      const size = file.blob?.size ?? null;
      const existing = this.get(projectId, file.key);
      const id = existing?.id ?? this.newId();
      if (existing) {
        this.db
          .prepare(
            `UPDATE files SET media_type = ?, value = ?, blob_hash = ?, size = ?,
             updated_at = ?, deleted_at = NULL WHERE id = ?`,
          )
          .run(type, file.value, hash, size, now, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO files (id, profile_id, project_id, key, media_type, value, blob_hash, size, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            activeProfile(this.db),
            projectId,
            file.key,
            type,
            file.value,
            hash,
            size,
            now,
            now,
          );
      }
      this.addVersion(id, type, file.value, file.blob, false, author, now);
      // A binary file is found by its derived text, when it has one.
      this.reindex(
        projectId,
        file.key,
        file.blob
          ? indexedText(getDerived(this.db, file.blob.hash))
          : file.value,
      );
      return this.get(projectId, file.key) as FileRow;
    })();
  }

  /** Marks the file deleted. False when there is no such live file. */
  delete(projectId: string | null, key: string, author: FileAuthor): boolean {
    return this.db.transaction(() => {
      const existing = this.get(projectId, key);
      if (!existing || existing.deleted_at !== null) return false;
      const now = this.now();
      this.db
        .prepare("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?")
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
      this.reindex(projectId, key, null);
      return true;
    })();
  }

  /** Oldest first. Empty when the file does not exist. */
  versions(projectId: string | null, key: string): VersionRow[] {
    const file = this.get(projectId, key);
    if (!file) return [];
    return this.db
      .prepare(
        `SELECT seq, media_type, value, blob_hash, size, deleted, author, session_id, run_id, created_at
         FROM file_versions WHERE file_id = ? ORDER BY seq`,
      )
      .all(file.id) as VersionRow[];
  }

  private addVersion(
    fileId: string,
    type: MediaType | null,
    value: string,
    blob: BlobRef | undefined,
    deleted: boolean,
    author: FileAuthor,
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO file_versions
           (file_id, seq, media_type, value, blob_hash, size, deleted, author, session_id, run_id, created_at)
         VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM file_versions WHERE file_id = ?),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        fileId,
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
    if (blob) this.pruneBinaryVersions(fileId);
  }

  /**
   * A binary file keeps its last `BINARY_VERSIONS_KEPT` versions (D12). The
   * older ones are deleted, and their bytes with them when nothing else
   * points at them.
   */
  private pruneBinaryVersions(fileId: string) {
    const removed = this.db
      .prepare(
        `DELETE FROM file_versions
         WHERE file_id = ? AND blob_hash IS NOT NULL AND seq NOT IN (
           SELECT seq FROM file_versions
           WHERE file_id = ? AND blob_hash IS NOT NULL
           ORDER BY seq DESC LIMIT ?)`,
      )
      .run(fileId, fileId, BINARY_VERSIONS_KEPT).changes;
    if (removed > 0) sweepBlobs(this.db);
  }

  /** The explicit folders of a scope, ordered by path. */
  listFolders(projectId: string | null): string[] {
    return (
      this.db
        .prepare(
          "SELECT path FROM folders WHERE profile_id = ? AND project_id IS ? ORDER BY path",
        )
        .all(activeProfile(this.db), projectId) as { path: string }[]
    ).map((r) => r.path);
  }

  createFolder(projectId: string | null, path: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO folders (profile_id, project_id, path, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(activeProfile(this.db), projectId, path, this.now());
  }

  /** Moves the folder's rows, its explicit subfolders and its live files. */
  renameFolder(
    projectId: string | null,
    from: string,
    to: string,
    author: FileAuthor,
  ) {
    this.db.transaction(() => {
      const rename = (path: string) => `${to}${path.slice(from.length)}`;
      for (const row of this.list(projectId)) {
        if (!isInFolder(row.key, from)) continue;
        this.put(
          projectId,
          {
            key: rename(row.key),
            value: row.value,
            ...(row.media_type ? { mediaType: row.media_type } : {}),
            ...(blobOf(row) ? { blob: blobOf(row) as BlobRef } : {}),
          },
          author,
        );
        this.delete(projectId, row.key, author);
      }
      for (const path of this.listFolders(projectId)) {
        if (!isInFolder(path, from)) continue;
        this.db
          .prepare(
            "DELETE FROM folders WHERE profile_id = ? AND project_id IS ? AND path = ?",
          )
          .run(activeProfile(this.db), projectId, path);
        this.createFolder(projectId, rename(path));
      }
      // A folder that only held files gets a row, so it still exists empty.
      this.createFolder(projectId, to);
    })();
  }

  /** Deletes the folder's rows and soft-deletes its live files. */
  deleteFolder(projectId: string | null, path: string, author: FileAuthor) {
    this.db.transaction(() => {
      for (const row of this.list(projectId)) {
        if (isInFolder(row.key, path)) {
          this.delete(projectId, row.key, author);
        }
      }
      for (const f of this.listFolders(projectId)) {
        if (isInFolder(f, path)) {
          this.db
            .prepare(
              "DELETE FROM folders WHERE profile_id = ? AND project_id IS ? AND path = ?",
            )
            .run(activeProfile(this.db), projectId, f);
        }
      }
    })();
  }

  /** The `SharedFiles` tools use in a session of this project (or none). */
  shared(projectId: string | null): SharedFiles {
    const pid = (scope: SharedScope): string | null => {
      if (scope === "global") return null;
      if (projectId === null) {
        throw new Error("This session is not in a project.");
      }
      return projectId;
    };
    const toShared = (r: FileRow) => ({
      key: r.key,
      value: r.value,
      ...(r.media_type ? { mediaType: r.media_type } : {}),
      ...(blobOf(r) ? { blob: blobOf(r) as BlobRef } : {}),
      updatedAt: r.updated_at,
    });
    return {
      list: (scope) => this.list(pid(scope)).map(toShared),
      get: (scope, key) => {
        const row = this.get(pid(scope), key);
        return row && row.deleted_at === null ? toShared(row) : undefined;
      },
      put: (scope, file, author) => {
        this.put(pid(scope), file, author);
      },
      delete: (scope, key, author) => this.delete(pid(scope), key, author),
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
