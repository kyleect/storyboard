import {
  mediaKindOf,
  parseRef,
  replaySessionEntries,
  type BlobRef,
  type MediaType,
  type ResolvedFile,
  type SessionEntries,
} from "@harness/core";
import { getBlob } from "./blobs.js";
import type { EntryStore } from "./entries-store.js";
import type { Store } from "./store.js";

/*
 * Finds the file a reference names (files unification design, D5, D7), for a
 * session: `session://` in its transcript, `project://` in its project and
 * `global://` in the global scope. A workspace reference is found through
 * `workspaces` and is only ever an image or audio file.
 */

export interface FoundFile {
  mediaType: MediaType;
  /** Binary files only. */
  blob?: BlobRef;
  /** A workspace media file: its bytes are on disk, read when needed. */
  bytes?: () => Buffer | undefined;
}

/** Finds a media file in a workspace the session has. */
export type WorkspaceMedia = (
  id: string,
  path: string,
) => { mediaType: string; bytes: () => Buffer | undefined } | undefined;

/**
 * A lookup for one session. The transcript is read the first time a session
 * file is asked for, and again when messages were added since.
 */
export function fileLookup(
  store: Store,
  entries: EntryStore | undefined,
  sessionId: string,
  workspaces?: WorkspaceMedia,
): (ref: string) => FoundFile | undefined {
  let state: SessionEntries | undefined;
  let seen = "";
  // A switch between branches changes the tip and no row count; a run adds
  // rows. Either means the transcript must be read again.
  const version = store.db.prepare(
    `SELECT coalesce(s.tip_id, '') || ':' || (SELECT count(*) FROM messages WHERE session_id = s.id) AS v
     FROM sessions s WHERE s.id = ?`,
  );
  return (ref) => {
    const parsed = parseRef(ref);
    if (!parsed) return undefined;
    if (parsed.location === "workspace") {
      const file = workspaces?.(parsed.workspaceId, parsed.path);
      return file
        ? { mediaType: file.mediaType as MediaType, bytes: file.bytes }
        : undefined;
    }
    if (parsed.location === "session") {
      // Read again when messages were added or the line changed since: a
      // run adds files.
      const n = (version.get(sessionId) as { v: string } | undefined)?.v ?? "";
      if (!state || n !== seen) {
        seen = n;
        state = replaySessionEntries(
          store.listMessages(sessionId).map((m) => m.message),
        );
      }
      const file = state.file.get(parsed.path);
      return file
        ? {
            mediaType: file.mediaType ?? "text/plain",
            ...(file.blob ? { blob: file.blob } : {}),
          }
        : undefined;
    }
    if (!entries) return undefined;
    const projectId =
      parsed.location === "global"
        ? null
        : (store.getSession(sessionId)?.project_id ?? undefined);
    if (projectId === undefined) return undefined;
    const row = entries.get("file", projectId, parsed.path);
    if (!row || row.deleted_at !== null || row.media_type === null) {
      return undefined;
    }
    return {
      mediaType: row.media_type,
      ...(row.blob_hash !== null
        ? { blob: { hash: row.blob_hash, size: row.size ?? 0 } }
        : {}),
    };
  };
}

/** The file's kind, media type and bytes as base64, for a model request. */
export function fileResolver(
  store: Store,
  entries: EntryStore | undefined,
  sessionId: string,
  workspaces?: WorkspaceMedia,
): (ref: string) => ResolvedFile | undefined {
  const find = fileLookup(store, entries, sessionId, workspaces);
  return (ref) => {
    const found = find(ref);
    const kind = found && mediaKindOf(found.mediaType);
    if (!found || !kind) return undefined;
    if (found.bytes) {
      const data = found.bytes();
      return data
        ? { kind, mediaType: found.mediaType, data: data.toString("base64") }
        : undefined;
    }
    if (!found.blob) return undefined;
    const blob = getBlob(store.db, found.blob.hash);
    return blob
      ? {
          kind,
          mediaType: found.mediaType,
          data: blob.data.toString("base64"),
        }
      : undefined;
  };
}
