import type { Database } from "better-sqlite3-multiple-ciphers";
import { createHash } from "node:crypto";
import type { BlobRef } from "@harness/core";

/*
 * The bytes of binary files (files unification design, D11, D12), kept once
 * by the SHA-256 of their content in the `blobs` table (0026).
 */

export const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Stores the bytes if they are not stored yet; returns where they are. */
export function putBlob(
  db: Database,
  mediaType: string,
  data: Buffer,
  now: string,
): BlobRef {
  const hash = sha256(data);
  db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, media_type, size, data, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hash, mediaType, data.length, data, now);
  return { hash, size: data.length };
}

/** The media type and bytes under a hash. */
export function getBlob(
  db: Database,
  hash: string,
): { mediaType: string; data: Buffer } | undefined {
  const row = db
    .prepare("SELECT media_type, data FROM blobs WHERE hash = ?")
    .get(hash) as { media_type: string; data: Buffer } | undefined;
  return row ? { mediaType: row.media_type, data: row.data } : undefined;
}

/**
 * Deletes the blobs that nothing points at: no file record, no version, no
 * skill file and no stored message (a session file's operation names its hash). Returns how
 * many it deleted. Called after versions are pruned and after a session or
 * project is purged (Q10).
 */
export function sweepBlobs(db: Database): number {
  const candidates = db
    .prepare(
      `SELECT hash FROM blobs
       WHERE hash NOT IN (SELECT blob_hash FROM files WHERE blob_hash IS NOT NULL)
         AND hash NOT IN (SELECT blob_hash FROM file_versions WHERE blob_hash IS NOT NULL)
         AND hash NOT IN (SELECT blob_hash FROM skill_files WHERE blob_hash IS NOT NULL)`,
    )
    .all() as { hash: string }[];
  const used = db.prepare(
    "SELECT 1 FROM messages WHERE instr(message, ?) > 0 LIMIT 1",
  );
  const remove = db.prepare("DELETE FROM blobs WHERE hash = ?");
  let removed = 0;
  for (const { hash } of candidates) {
    if (used.get(hash)) continue;
    remove.run(hash);
    removed++;
  }
  return removed;
}
