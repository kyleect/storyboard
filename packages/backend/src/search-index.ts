import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  chunkText,
  replaySessionEntries,
  type EntryKind,
  type Scope,
} from "@harness/core";

/*
 * The search index over files and memory notes (files and memory design,
 * decisions 22 to 30; plan P2, P8, S1, S2, S6). Live entries are split
 * into chunks; a full-text index (FTS5, Porter stemming) and one vector per
 * chunk sit beside them. A chunk without a vector for the current model is
 * waiting to be embedded.
 */

export interface ChunkRow {
  id: number;
  scope: Scope;
  key: string;
  text: string;
}

/** Which scopes a search covers: the session's, its project's, global. */
export interface ScopeFilter {
  sessionId: string | null;
  projectId: string | null;
  global: boolean;
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

function scopeSql(filter: ScopeFilter): { sql: string; params: string[] } {
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
  if (filter.global) parts.push("c.scope = 'global'");
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", params };
}

export class SearchIndex {
  /** Called after chunks are added, so the embedder can start. */
  onChunksAdded: () => void = () => {};

  constructor(readonly db: Database) {}

  /**
   * Replaces one entry's chunks. `value` null (a deleted entry) removes
   * them. A note is one chunk; a file is split (S1, S2).
   */
  indexEntry(
    kind: EntryKind,
    scope: Scope,
    ownerId: string | null,
    key: string,
    value: string | null,
  ) {
    const chunks =
      value === null
        ? []
        : kind === "note"
          ? value.trim()
            ? [value]
            : []
          : chunkText(value);
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM chunks WHERE kind = ? AND scope = ? AND owner_id IS ? AND key = ?",
        )
        .run(kind, scope, ownerId, key);
      const insert = this.db.prepare(
        "INSERT INTO chunks (kind, scope, owner_id, key, seq, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      chunks.forEach((text, seq) =>
        insert.run(kind, scope, ownerId, key, seq, text),
      );
    })();
    if (chunks.length > 0) this.onChunksAdded();
  }

  /**
   * Indexes every existing entry once, after the migration that added the
   * index (its chunking is done here, not in SQL). Returns the number of
   * entries indexed, or null when the index was already built.
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
            "SELECT kind, project_id, key, value FROM entries WHERE deleted_at IS NULL",
          )
          .all() as {
          kind: EntryKind;
          project_id: string | null;
          key: string;
          value: string;
        }[];
        for (const e of shared) {
          this.indexEntry(
            e.kind,
            e.project_id === null ? "global" : "project",
            e.project_id,
            e.key,
            e.value,
          );
          count++;
        }
        const sessions = this.db.prepare("SELECT id FROM sessions").all() as {
          id: string;
        }[];
        const messages = this.db.prepare(
          "SELECT message FROM messages WHERE session_id = ? ORDER BY seq",
        );
        for (const { id } of sessions) {
          const rows = messages.all(id) as { message: string }[];
          const state = replaySessionEntries(
            rows.map((r) => JSON.parse(r.message) as never),
          );
          for (const kind of ["file", "note"] as const) {
            for (const [key, current] of state[kind]) {
              this.indexEntry(kind, "session", id, key, current.value);
              count++;
            }
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

  /** Chunks with no vector from `model`, oldest first. */
  pending(model: string, limit: number): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.key, c.text FROM chunks c
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ?
         WHERE v.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
      )
      .all(model, limit) as ChunkRow[];
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

  /** Removes vectors from any other model (S6). Returns how many. */
  dropOtherModels(model: string): number {
    return this.db
      .prepare("DELETE FROM chunk_vectors WHERE model != ?")
      .run(model).changes;
  }

  /** Best keyword matches, best first. */
  keyword(
    kind: EntryKind,
    filter: ScopeFilter,
    query: string,
    limit: number,
  ): ChunkRow[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    const scope = scopeSql(filter);
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.key, c.text
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND c.kind = ? AND ${scope.sql}
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(match, kind, ...scope.params, limit) as ChunkRow[];
  }

  /** Nearest chunks by cosine distance, nearest first (P2). */
  nearest(
    kind: EntryKind,
    filter: ScopeFilter,
    model: string,
    vector: readonly number[],
    limit: number,
  ): ChunkRow[] {
    const scope = scopeSql(filter);
    return this.db
      .prepare(
        `SELECT c.id, c.scope, c.key, c.text
         FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id
         WHERE v.model = ? AND c.kind = ? AND ${scope.sql}
         ORDER BY vec_distance_cosine(v.embedding, ?) LIMIT ?`,
      )
      .all(model, kind, ...scope.params, toBlob(vector), limit) as ChunkRow[];
  }
}
