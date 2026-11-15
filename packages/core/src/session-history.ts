/*
 * The history of the sessions an earlier session was continued from (session
 * rollover design, D17, D18). The tools reach it only through
 * `SessionHistory`, which the backend implements: it decides which sessions
 * are in the chain, searches their messages and reads them back.
 */

/** The most characters of one message `sessions_read` returns. */
export const HISTORY_MESSAGE_CHARS = 4000;

/** The most hits or messages one call may ask for. */
export const HISTORY_PAGE_MAX = 50;

export interface HistorySearchQuery {
  query: string;
  limit: number;
  /** How many hits to skip, to read the next page. */
  offset: number;
  signal?: AbortSignal;
}

export interface HistoryHit {
  sessionId: string;
  sessionTitle: string;
  /** The message that matched; `sessions_read` takes it. */
  messageId: string;
  excerpt: string;
  matched: "keyword" | "meaning" | "both";
}

export interface HistorySearchResult {
  hits: HistoryHit[];
  /** Whether more hits follow these (ask again with a larger `offset`). */
  hasMore: boolean;
  mode: "keyword+meaning" | "keyword";
  /** Why the search was keyword only, when it was. */
  notice?: string;
}

export interface HistoryReadQuery {
  sessionId: string;
  /** The message the window is centred on. */
  messageId: string;
  /** How many messages before it, and after it, to return. */
  before: number;
  after: number;
}

/** One message of an earlier session, as text. */
export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  /** For a tool result: the tool. */
  tool?: string;
  /** The text, cut to `HISTORY_MESSAGE_CHARS`. */
  text: string;
  /** For an assistant message: the tools it called. */
  calls?: string[];
  /** The text was cut. */
  truncated?: boolean;
}

export interface HistoryRead {
  sessionId: string;
  sessionTitle: string;
  messages: HistoryMessage[];
  /** More messages exist before the first returned, or after the last. */
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface SessionHistory {
  search(q: HistorySearchQuery): Promise<HistorySearchResult>;
  /** `error` says why not: a session outside the chain, an unknown message. */
  read(q: HistoryReadQuery): HistoryRead | { error: string };
}
