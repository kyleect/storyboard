import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  chunkText,
  Message,
  replaySessionFiles,
  type Scope,
} from "@harness/core";
import { activeProfile } from "./profiles.js";
import { activeLine, activeMessageJson } from "./transcript.js";

/*
 * The search index over files (files and memory design,
 * decisions 22 to 30; plan P2, P8, S1, S2, S6). Live files are split
 * into chunks; a full-text index (FTS5, Porter stemming) and one vector per
 * chunk sit beside them. A chunk without a vector for the current model is
 * waiting to be embedded.
 */

/**
 * Where a chunk comes from: a scope, a workspace (files unification design,
 * D45) or a session's transcript (session rollover design, D13). A workspace
 * chunk's owner is the workspace id and its key is the path inside it. A
 * transcript chunk's owner is the session and its key is the message id.
 */
export type ChunkScope = Scope | "workspace" | "transcript";

export interface ChunkRow {
  id: number;
  scope: ChunkScope;
  /** The session, project or workspace; null for global. */
  ownerId: string | null;
  key: string;
  text: string;
}

/** Which scopes a search covers: the session's, its project's, global. */
export interface ScopeFilter {
  sessionId: string | null;
  projectId: string | null;
  global: boolean;
  /** The workspaces to search; left out: none. */
  workspaceIds?: readonly string[];
  /** The sessions whose messages to search; left out: none. */
  transcriptSessionIds?: readonly string[];
}

/**
 * The text of a message that is searched later (session rollover design,
 * D10): what the user wrote, what the assistant said (not its reasoning or
 * its tool calls) and what a tool returned. Anything else gives "".
 */
export function transcriptText(message: Message): string {
  switch (message.role) {
    case "user":
    case "tool":
      return message.content;
    case "assistant":
      return message.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n");
    default:
      return "";
  }
}

/** Float32 little-endian bytes, as sqlite-vec reads them. */
export const toBlob = (v: readonly number[]): Buffer => {
  const a = new Float32Array(v);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
};

/** FTS5 query: each word quoted, any word may match. Null: no words. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return null;
  return words.map((w) => `"${w}"`).join(" OR ");
}

/**
 * Only the global scope needs the profile: its chunks have no owner id, while
 * a session's, project's or workspace's chunks are found by an id that
 * belongs to one profile (profiles design 4.5).
 */
function scopeSql(
  filter: ScopeFilter,
  profile: string,
): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.sessionId !== null) {
    parts.push("(c.scope = 'session' AND c.owner_id = ?)");
    params.push(filter.sessionId);
  }
  if (filter.projectId !== null) {
    parts.push("(c.scope = 'project' AND c.owner_id = ?)");
    params.push(filter.projectId);
  }
  if (filter.global) {
    parts.push("(c.scope = 'global' AND c.profile_id = ?)");
    params.push(profile);
  }
  if (filter.workspaceIds && filter.workspaceIds.length > 0) {
    parts.push(
      `(c.scope = 'workspace' AND c.owner_id IN (${filter.workspaceIds.map(() => "?").join(", ")}))`,
    );
    params.push(...filter.workspaceIds);
  }
  if (filter.transcriptSessionIds && filter.transcriptSessionIds.length > 0) {
    parts.push(
      `(c.scope = 'transcript' AND c.owner_id IN (${filter.transcriptSessionIds.map(() => "?").join(", ")}))`,
    );
    params.push(...filter.transcriptSessionIds);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", params };
}

export class SearchIndex {
  /** Called after chunks are added, so the embedder can start. */
  onChunksAdded: () => void = () => {};

  constructor(readonly db: Database) {}

  /**
   * Replaces one file's chunks. `value` null (a deleted file) removes
   * them. A file is split into chunks (S1, S2).
   */
  indexFile(
    scope: ChunkScope,
    ownerId: string | null,
    key: string,
    value: string | null,
    /** Whose file it is. Default: the active profile. */
    profileId: string = activeProfile(this.db),
  ) {
    const chunks = value === null ? [] : chunkText(value);
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM chunks WHERE profile_id = ? AND scope = ? AND owner_id IS ? AND key = ?",
        )
        .run(profileId, scope, ownerId, key);
      const insert = this.db.prepare(
        "INSERT INTO chunks (profile_id, scope, owner_id, key, seq, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      chunks.forEach((text, seq) =>
        insert.run(profileId, scope, ownerId, key, seq, text),
      );
    })();
    if (chunks.length > 0) this.onChunksAdded();
  }

  /**
   * Replaces one message's chunks with those of its text (session rollover
   * design, D12, D14). A message with no searchable text has none. A large
   * message is split into several chunks that share its key.
   */
  indexMessage(
    sessionId: string,
    messageId: string,
    message: Message,
    profileId: string = activeProfile(this.db),
  ) {
    const text = transcriptText(message);
    this.indexFile(
      "transcript",
      sessionId,
      messageId,
      text.trim() === "" ? null : text,
      profileId,
    );
  }

  /**
   * Makes the session's transcript chunks match the line it shows: those of
   * messages that are not on it are removed, and a message on it that has no
   * chunks yet is indexed (D11, and the sessions that existed before the
   * index). Chunks of messages that stay are left alone, so their vectors
   * are kept. Returns how many messages were removed and added.
   */
  reconcileTranscript(sessionId: string): { removed: number; added: number } {
    const session = this.db
      .prepare("SELECT profile_id FROM sessions WHERE id = ?")
      .get(sessionId) as { profile_id: string } | undefined;
    if (!session) return { removed: 0, added: 0 };
    const line = activeLine(this.db, sessionId);
    const onLine = new Set(line.map((m) => m.id));
    const indexed = new Set(
      (
        this.db
          .prepare(
            "SELECT DISTINCT key FROM chunks WHERE scope = 'transcript' AND owner_id = ?",
          )
          .all(sessionId) as { key: string }[]
      ).map((r) => r.key),
    );
    let removed = 0;
    let added = 0;
    const silent = this.onChunksAdded;
    this.onChunksAdded = () => {};
    try {
      this.db.transaction(() => {
        const drop = this.db.prepare(
          "DELETE FROM chunks WHERE scope = 'transcript' AND owner_id = ? AND key = ?",
        );
        for (const key of indexed) {
          if (onLine.has(key)) continue;
          drop.run(sessionId, key);
          removed++;
        }
        for (const { id, message } of line) {
          if (indexed.has(id)) continue;
          const parsed = Message.parse(JSON.parse(message));
          if (transcriptText(parsed).trim() === "") continue;
          this.indexMessage(sessionId, id, parsed, session.profile_id);
          added++;
        }
      })();
    } finally {
      this.onChunksAdded = silent;
    }
    if (added > 0) this.onChunksAdded();
    return { removed, added };
  }

  /**
   * Replaces the chunks of the session's own files with those of
   * the line it shows now. For after the line changes (a switch, an edit or
   * a deleted branch): files of the branch left are no longer searched.
   */
  reindexSession(sessionId: string) {
    const state = replaySessionFiles(
      activeMessageJson(this.db, sessionId).map((m) => JSON.parse(m) as never),
    );
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM chunks WHERE scope = 'session' AND owner_id = ?")
        .run(sessionId);
      for (const [key, current] of state.files) {
        this.indexFile("session", sessionId, key, current.value);
      }
    })();
  }

  /** Removes the chunks of some files of a workspace, or all with no paths. */
  dropWorkspaceFiles(workspaceId: string, paths?: readonly string[]) {
    const del = this.db.prepare(
      "DELETE FROM chunks WHERE scope = 'workspace' AND owner_id = ? AND key = ?",
    );
    this.db.transaction(() => {
      if (paths === undefined) {
        this.db
          .prepare(
            "DELETE FROM chunks WHERE scope = 'workspace' AND owner_id = ?",
          )
          .run(workspaceId);
      } else {
        for (const p of paths) del.run(workspaceId, p);
      }
    })();
  }

  /**
   * Indexes every existing file once, after the migration that added the
   * index (its chunking is done here, not in SQL). Returns the number of
   * files indexed, or null when the index was already built.
   */
  buildIfNeeded(): number | null {
    const state = this.db
      .prepare("SELECT built FROM search_index_state WHERE id = 1")
      .get() as { built: number };
    if (state.built === 1) return null;
    let count = 0;
    const silent = this.onChunksAdded;
    this.onChunksAdded = () => {};
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM chunks").run();
        const shared = this.db
          .prepare(
            "SELECT profile_id, project_id, key, value FROM files WHERE deleted_at IS NULL",
          )
          .all() as {
          profile_id: string;
          project_id: string | null;
          key: string;
          value: string;
        }[];
        for (const e of shared) {
          this.indexFile(
            e.project_id === null ? "global" : "project",
            e.project_id,
            e.key,
            e.value,
            e.profile_id,
          );
          count++;
        }
        const sessions = this.db
          .prepare("SELECT id, profile_id FROM sessions")
          .all() as { id: string; profile_id: string }[];
        for (const { id, profile_id } of sessions) {
          // The line the session shows, not every branch (message editing
          // plan, part A): files that exist only on another branch are not
          // searched until it is switched to.
          const state = replaySessionFiles(
            activeMessageJson(this.db, id).map((m) => JSON.parse(m) as never),
          );
          for (const [key, current] of state.files) {
            this.indexFile("session", id, key, current.value, profile_id);
            count++;
          }
        }
        this.db
          .prepare("UPDATE search_index_state SET built = 1 WHERE id = 1")
          .run();
      })();
    } finally {
      this.onChunksAdded = silent;
    }
    if (count > 0) this.onChunksAdded();
    return count;
  }

  /**
   * The active profile's chunks with no vector from `model`, oldest first.
   * Each profile has its own embedding model, so another profile's chunks
   * wait until it is switched to (profiles design 4.5).
   */
  pending(model: string, limit: number): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.owner_id AS ownerId, c.key, c.text FROM chunks c
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ?
         WHERE c.profile_id = ? AND v.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
      )
      .all(model, activeProfile(this.db), limit) as ChunkRow[];
  }

  /** Stores vectors; chunks deleted meanwhile are skipped. */
  saveVectors(model: string, vectors: { id: number; vector: number[] }[]) {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO chunk_vectors (chunk_id, model, embedding)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)`,
    );
    this.db.transaction(() => {
      for (const v of vectors) {
        insert.run(v.id, model, toBlob(v.vector), v.id);
      }
    })();
  }

  /**
   * Removes the active profile's vectors from any other model (S6). Other
   * profiles' vectors are theirs to keep. Returns how many.
   */
  dropOtherModels(model: string): number {
    return this.db
      .prepare(
        `DELETE FROM chunk_vectors WHERE model != ?
         AND chunk_id IN (SELECT id FROM chunks WHERE profile_id = ?)`,
      )
      .run(model, activeProfile(this.db)).changes;
  }

  /** Best keyword matches, best first. */
  keyword(filter: ScopeFilter, query: string, limit: number): ChunkRow[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    const scope = scopeSql(filter, activeProfile(this.db));
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.owner_id AS ownerId, c.key, c.text
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND ${scope.sql}
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(match, ...scope.params, limit) as ChunkRow[];
  }

  /** Nearest chunks by cosine distance, nearest first (P2). */
  nearest(
    filter: ScopeFilter,
    model: string,
    vector: readonly number[],
    limit: number,
  ): ChunkRow[] {
    const scope = scopeSql(filter, activeProfile(this.db));
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.owner_id AS ownerId, c.key, c.text
         FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id
         WHERE v.model = ? AND ${scope.sql}
         ORDER BY vec_distance_cosine(v.embedding, ?) LIMIT ?`,
      )
      .all(model, ...scope.params, toBlob(vector), limit) as ChunkRow[];
  }
}
