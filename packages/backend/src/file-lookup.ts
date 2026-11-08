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
 * `global://` in the global scope. Workspace references are not handled
 * here.
 */

export interface FoundFile {
  mediaType: MediaType;
  /** Binary files only. */
  blob?: BlobRef;
}

/**
 * A lookup for one session. The transcript is read the first time a session
 * file is asked for, and again when messages were added since.
 */
export function fileLookup(
  store: Store,
  entries: EntryStore | undefined,
  sessionId: string,
): (ref: string) => FoundFile | undefined {
  let state: SessionEntries | undefined;
  let seen = -1;
  const count = store.db.prepare(
    "SELECT count(*) AS n FROM messages WHERE session_id = ?",
  );
  return (ref) => {
    const parsed = parseRef(ref);
    if (!parsed || parsed.location === "workspace") return undefined;
    if (parsed.location === "session") {
      // Read again when messages were added since: a run adds files.
      const n = (count.get(sessionId) as { n: number }).n;
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
): (ref: string) => ResolvedFile | undefined {
  const find = fileLookup(store, entries, sessionId);
  return (ref) => {
    const found = find(ref);
    const kind = found && mediaKindOf(found.mediaType);
    if (!found?.blob || !kind) return undefined;
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
