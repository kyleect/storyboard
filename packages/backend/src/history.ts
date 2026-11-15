import {
  HISTORY_MESSAGE_CHARS,
  truncate,
  type HistoryMessage,
  type SessionHistory,
} from "@harness/core";
import { fusedSearch, type SearchEngine } from "./search.js";
import { transcriptText } from "./search-index.js";
import type { Store, StoredMessage } from "./store.js";

/*
 * The earlier sessions of a chain, for `sessions_search` and `sessions_read`
 * (session rollover design, D17, D18). Only the sessions this one continues
 * can be reached: a session id outside that chain is refused, so the tools
 * never read another conversation.
 */

export interface HistoryOptions extends SearchEngine {
  store: Store;
  /** The session the tools run in. */
  sessionId: string;
}

/** A message as the model reads it back. */
function historyMessage(m: StoredMessage): HistoryMessage | undefined {
  const message = m.message;
  switch (message.role) {
    case "user":
      return { id: m.id, role: "user", ...cut(message.content) };
    case "tool":
      return {
        id: m.id,
        role: "tool",
        tool: message.name,
        ...cut(message.content),
      };
    case "assistant": {
      const calls = message.content.flatMap((b) =>
        b.type === "tool_call" ? [b.name] : [],
      );
      return {
        id: m.id,
        role: "assistant",
        ...cut(transcriptText(message)),
        ...(calls.length > 0 ? { calls } : {}),
      };
    }
    default:
      return undefined;
  }
}

function cut(text: string): { text: string; truncated?: boolean } {
  return text.length > HISTORY_MESSAGE_CHARS
    ? { text: truncate(text, HISTORY_MESSAGE_CHARS), truncated: true }
    : { text };
}

export function sessionHistory(options: HistoryOptions): SessionHistory {
  const { store, sessionId } = options;
  const chain = () => store.chainBefore(sessionId);
  return {
    async search(q) {
      const ids = chain();
      if (ids.length === 0)
        return { hits: [], hasMore: false, mode: "keyword" };
      // One more than asked for tells whether another page follows.
      const found = await fusedSearch(
        options,
        {
          sessionId: null,
          projectId: null,
          global: false,
          transcriptSessionIds: ids,
        },
        q.query,
        q.offset + q.limit + 1,
        q.signal,
      );
      const titles = new Map(
        ids.map((id) => [id, store.getSession(id)?.title ?? ""]),
      );
      const page = found.hits.slice(q.offset, q.offset + q.limit);
      return {
        hits: page.flatMap((h) =>
          h.row.scope === "transcript" && h.row.ownerId !== null
            ? [
                {
                  sessionId: h.row.ownerId,
                  sessionTitle: titles.get(h.row.ownerId) ?? "",
                  messageId: h.row.key,
                  excerpt: h.row.text,
                  matched: h.matched,
                },
              ]
            : [],
        ),
        hasMore: found.hits.length > q.offset + q.limit,
        mode: found.mode,
        ...(found.notice !== undefined ? { notice: found.notice } : {}),
      };
    },
    read(q) {
      if (!chain().includes(q.sessionId)) {
        return {
          error:
            "That session is not one this session was continued from. Take the session id from sessions_search.",
        };
      }
      const session = store.getSession(q.sessionId);
      const line = store.listMessages(q.sessionId, "top");
      const at = line.findIndex((m) => m.id === q.messageId);
      if (!session || at < 0) {
        return {
          error:
            "That message is not in the session's conversation. Take the message id from sessions_search.",
        };
      }
      const from = Math.max(0, at - q.before);
      const to = Math.min(line.length, at + q.after + 1);
      return {
        sessionId: q.sessionId,
        sessionTitle: session.title,
        messages: line.slice(from, to).flatMap((m) => {
          const shown = historyMessage(m);
          return shown ? [shown] : [];
        }),
        hasBefore: from > 0,
        hasAfter: to < line.length,
      };
    },
  };
}
