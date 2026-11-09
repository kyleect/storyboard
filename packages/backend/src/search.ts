import type {
  EntryKind,
  EntrySearch,
  SearchHit,
  SearchResult,
} from "@harness/core";
import { withTaskPrefix } from "./embed-prefix.js";
import type { ChunkRow, ScopeFilter, SearchIndex } from "./search-index.js";

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

/** What every search needs besides what to look in. */
export interface SearchEngine {
  index: SearchIndex;
  /** The embedding model setting; empty: none. */
  embeddingModel: () => string;
  /** Embeds the query with that model. */
  embed: (
    model: string,
    texts: string[],
    signal?: AbortSignal,
  ) => Promise<number[][]>;
}

export interface SessionSearchOptions extends SearchEngine {
  sessionId: string;
  projectId: string | null;
}

export interface FusedHit {
  row: ChunkRow;
  matched: "keyword" | "meaning" | "both";
}

/**
 * Keyword and meaning search over the chunks `filter` covers, fused and
 * reduced to each entry's best chunk, best first. `limit` undefined: every
 * match.
 */
export async function fusedSearch(
  engine: SearchEngine,
  filter: ScopeFilter,
  kind: EntryKind,
  query: string,
  limit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  hits: FusedHit[];
  mode: "keyword+meaning" | "keyword";
  notice?: string;
}> {
  const { index } = engine;
  // With no limit every match is a candidate (-1: no SQL LIMIT).
  const candidates = limit === undefined ? -1 : Math.max(50, limit * 5);
  const keyword = index.keyword(kind, filter, query, candidates);

  let nearest: ChunkRow[] = [];
  let notice: string | undefined;
  const model = engine.embeddingModel();
  if (!model) {
    notice = "No embedding model is set, so this was a keyword search only.";
  } else {
    try {
      const [vector] = await engine.embed(
        model,
        [withTaskPrefix(model, "query", query)],
        signal,
      );
      if (vector) {
        nearest = index.nearest(kind, filter, model, vector, candidates);
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
    const id = `${c.row.scope}\u0000${c.row.ownerId ?? ""}\u0000${c.row.key}`;
    const best = byEntry.get(id);
    if (!best || c.score > best.score) byEntry.set(id, c);
  }
  const hits: FusedHit[] = [...byEntry.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => ({
      row: c.row,
      matched:
        c.keyword && c.meaning ? "both" : c.keyword ? "keyword" : "meaning",
    }));
  return {
    hits,
    mode: notice === undefined ? "keyword+meaning" : "keyword",
    ...(notice !== undefined ? { notice } : {}),
  };
}

/** One search of the ticked parts of workspaces. */
export interface WorkspaceQuery {
  query: string;
  limit: number;
  workspaceIds: readonly string[];
  signal?: AbortSignal;
}

export interface WorkspaceChunkHit {
  workspaceId: string;
  path: string;
  excerpt: string;
  matched: "keyword" | "meaning" | "both";
}

/** Searches what is indexed in the given workspaces (D45). */
export async function searchWorkspaces(
  engine: SearchEngine,
  q: WorkspaceQuery,
): Promise<{
  hits: WorkspaceChunkHit[];
  mode: "keyword+meaning" | "keyword";
  notice?: string;
}> {
  const found = await fusedSearch(
    engine,
    {
      sessionId: null,
      projectId: null,
      global: false,
      workspaceIds: q.workspaceIds,
    },
    "file",
    q.query,
    q.limit,
    q.signal,
  );
  return {
    ...found,
    hits: found.hits.flatMap((h) =>
      h.row.ownerId === null
        ? []
        : [
            {
              workspaceId: h.row.ownerId,
              path: h.row.key,
              excerpt: h.row.text,
              matched: h.matched,
            },
          ],
    ),
  };
}

export function sessionSearch(options: SessionSearchOptions): EntrySearch {
  return async (q): Promise<SearchResult> => {
    const filter = {
      sessionId: q.scopes.includes("session") ? options.sessionId : null,
      projectId:
        q.scopes.includes("project") && options.projectId !== null
          ? options.projectId
          : null,
      global: q.scopes.includes("global"),
    };
    const found = await fusedSearch(
      options,
      filter,
      q.kind,
      q.query,
      q.limit,
      q.signal,
    );
    const hits: SearchHit[] = found.hits.flatMap((h) =>
      h.row.scope === "workspace"
        ? []
        : [
            {
              scope: h.row.scope,
              key: h.row.key,
              excerpt: h.row.text,
              matched: h.matched,
            },
          ],
    );
    return {
      hits,
      mode: found.mode,
      ...(found.notice !== undefined ? { notice: found.notice } : {}),
    };
  };
}
