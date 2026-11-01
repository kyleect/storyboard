import type { EntrySearch, SearchHit, SearchResult } from "@harness/core";
import type { ChunkRow, SearchIndex } from "./search-index.js";

/*
 * Searching files and notes for one session (files and memory design,
 * decisions 22, 23, 26 and 30): keyword (FTS5) and vector results merged
 * with reciprocal rank fusion, grouped by entry; the best chunk of a file
 * is its excerpt. Without an embedding model, or when the query cannot be
 * embedded, the search is keyword only and says why.
 */

/** Reciprocal rank fusion constant (the usual value). */
const RRF_K = 60;

interface Fused {
  row: ChunkRow;
  score: number;
  keyword: boolean;
  meaning: boolean;
}

export interface SessionSearchOptions {
  index: SearchIndex;
  sessionId: string;
  projectId: string | null;
  /** The embedding model setting; empty: none. */
  embeddingModel: () => string;
  /** Embeds the query with that model. */
  embed: (
    model: string,
    texts: string[],
    signal?: AbortSignal,
  ) => Promise<number[][]>;
}

export function sessionSearch(options: SessionSearchOptions): EntrySearch {
  const { index } = options;
  return async (q): Promise<SearchResult> => {
    const filter = {
      sessionId: q.scopes.includes("session") ? options.sessionId : null,
      projectId:
        q.scopes.includes("project") && options.projectId !== null
          ? options.projectId
          : null,
      global: q.scopes.includes("global"),
    };
    const candidates = Math.max(50, q.limit * 5);
    const keyword = index.keyword(q.kind, filter, q.query, candidates);

    let nearest: ChunkRow[] = [];
    let notice: string | undefined;
    const model = options.embeddingModel();
    if (!model) {
      notice = "No embedding model is set, so this was a keyword search only.";
    } else {
      try {
        const [vector] = await options.embed(model, [q.query], q.signal);
        if (vector) {
          nearest = index.nearest(q.kind, filter, model, vector, candidates);
        }
      } catch (err) {
        notice = `The query could not be embedded (${(err as Error).message}), so this was a keyword search only.`;
      }
    }

    // Fuse the two rankings per chunk, then keep each entry's best chunk.
    const byChunk = new Map<number, Fused>();
    const add = (rows: ChunkRow[], which: "keyword" | "meaning") =>
      rows.forEach((row, rank) => {
        const entry = byChunk.get(row.id) ?? {
          row,
          score: 0,
          keyword: false,
          meaning: false,
        };
        entry.score += 1 / (RRF_K + rank + 1);
        entry[which] = true;
        byChunk.set(row.id, entry);
      });
    add(keyword, "keyword");
    add(nearest, "meaning");

    const byEntry = new Map<string, Fused>();
    for (const c of byChunk.values()) {
      const id = `${c.row.scope}\u0000${c.row.key}`;
      const best = byEntry.get(id);
      if (!best || c.score > best.score) byEntry.set(id, c);
    }
    const hits: SearchHit[] = [...byEntry.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit)
      .map((c) => ({
        scope: c.row.scope,
        key: c.row.key,
        excerpt: c.row.text,
        matched:
          c.keyword && c.meaning ? "both" : c.keyword ? "keyword" : "meaning",
      }));

    return {
      hits,
      mode: notice === undefined ? "keyword+meaning" : "keyword",
      ...(notice !== undefined ? { notice } : {}),
    };
  };
}
