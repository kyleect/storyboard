import type { Database } from "better-sqlite3-multiple-ciphers";

/*
 * Readers of a session's transcript that work on the database directly (the
 * search index and the media describer have no `Store`). A session is a tree
 * of messages; what the model and the files see is the line from the first
 * message to the session's tip, with the subagent messages anchored to it
 * (message editing plan, part A).
 */

/**
 * The stored JSON of the messages of the line the session shows, in `seq`
 * order, subagent messages included. A session with no tip (it has no
 * messages, or has not been through the branches data step) reads as all its
 * messages.
 */
export function activeMessageJson(db: Database, sessionId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE line(id, parent_id) AS (
           SELECT t.id, t.parent_id FROM messages t
             WHERE t.id = (SELECT tip_id FROM sessions WHERE id = @session)
           UNION ALL
           SELECT p.id, p.parent_id FROM messages p JOIN line ON p.id = line.parent_id)
         SELECT m.message FROM messages m
         WHERE m.session_id = @session
           AND (m.id IN (SELECT id FROM line)
             OR m.anchor_id IN (SELECT id FROM line)
             OR NOT EXISTS (SELECT 1 FROM line))
         ORDER BY m.seq`,
      )
      .all({ session: sessionId }) as { message: string }[]
  ).map((r) => r.message);
}
