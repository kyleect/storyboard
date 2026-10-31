import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  Message,
  type HarnessEvent,
  type StoredEvent,
  type Usage,
} from "@harness/core";

/* Plain SQL over the encrypted database (design doc 6.11). */

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  /** The session's chosen model; null means the default setting. */
  model: string | null;
}

export interface StoredMessage {
  id: string;
  message: Message;
  /** For assistant messages: the model of the run that last wrote it. */
  model: string | null;
}

export type RunStatus =
  "running" | "finished" | "failed" | "cancelled" | "interrupted";

export interface RunRow {
  id: string;
  session_id: string;
  kind: string;
  message_id: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  usage: string | null;
  error: string | null;
  model: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  session_id: string;
  time: string;
  type: string;
  data: string;
}

const toEvent = (r: EventRow): StoredEvent =>
  ({
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    time: r.time,
    type: r.type,
    data: JSON.parse(r.data) as unknown,
  }) as StoredEvent;

export class Store {
  constructor(readonly db: Database) {}

  createSession(id: string, title: string, now: string): SessionRow {
    this.db
      .prepare("INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)")
      .run(id, title, now);
    return { id, title, created_at: now, model: null };
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at, model FROM sessions ORDER BY created_at DESC",
      )
      .all() as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT id, title, created_at, model FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
  }

  setSessionModel(id: string, model: string | null) {
    this.db
      .prepare("UPDATE sessions SET model = ? WHERE id = ?")
      .run(model, id);
  }

  addMessage(
    sessionId: string,
    id: string,
    message: Message,
    now: string,
    model: string | null = null,
  ) {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, message, created_at, model)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?)`,
      )
      .run(id, sessionId, sessionId, JSON.stringify(message), now, model);
  }

  /** Inserts the message, or replaces it (and its model) if the id exists. */
  saveMessage(
    sessionId: string,
    id: string,
    message: Message,
    now: string,
    model: string | null = null,
  ) {
    const updated = this.db
      .prepare("UPDATE messages SET message = ?, model = ? WHERE id = ?")
      .run(JSON.stringify(message), model, id);
    if (updated.changes === 0)
      this.addMessage(sessionId, id, message, now, model);
  }

  getMessage(id: string): Message | undefined {
    const row = this.db
      .prepare("SELECT message FROM messages WHERE id = ?")
      .get(id) as { message: string } | undefined;
    return row ? Message.parse(JSON.parse(row.message)) : undefined;
  }

  listMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, message, model FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as {
      id: string;
      message: string;
      model: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      message: Message.parse(JSON.parse(r.message)),
      model: r.model,
    }));
  }

  createRun(run: {
    id: string;
    sessionId: string;
    kind: string;
    messageId: string;
    now: string;
    model?: string | null;
  }) {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, message_id, status, started_at, model)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        run.kind,
        run.messageId,
        run.now,
        run.model ?? null,
      );
  }

  endRun(
    id: string,
    status: Exclude<RunStatus, "running">,
    now: string,
    usage?: Usage,
    error?: string,
  ) {
    this.db
      .prepare(
        "UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ? WHERE id = ?",
      )
      .run(
        status,
        now,
        usage ? JSON.stringify(usage) : null,
        error ?? null,
        id,
      );
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      RunRow | undefined;
  }

  runningRuns(): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE status = 'running'")
      .all() as RunRow[];
  }

  insertEvent(event: HarnessEvent): StoredEvent {
    const result = this.db
      .prepare(
        "INSERT INTO events (run_id, session_id, time, type, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.runId,
        event.sessionId,
        event.time,
        event.type,
        JSON.stringify(event.data),
      );
    return { ...event, id: Number(result.lastInsertRowid) } as StoredEvent;
  }

  eventsAfter(sessionId: string, afterId: number): StoredEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id",
        )
        .all(sessionId, afterId) as EventRow[]
    ).map(toEvent);
  }

  runEvents(runId: string): StoredEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id")
        .all(runId) as EventRow[]
    ).map(toEvent);
  }

  lastEventId(sessionId: string): number {
    const row = this.db
      .prepare("SELECT max(id) AS id FROM events WHERE session_id = ?")
      .get(sessionId) as { id: number | null };
    return row.id ?? 0;
  }
}
