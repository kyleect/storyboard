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
  /** The session's chosen reasoning effort; null means the default. */
  reasoning_effort: string | null;
}

/** What a run sent to the model server; null where nothing was sent. */
export interface Generation {
  model: string | null;
  reasoningEffort: string | null;
}

const NO_GENERATION: Generation = { model: null, reasoningEffort: null };

export interface StoredMessage extends Generation {
  id: string;
  message: Message;
  // For assistant messages, `model` and `reasoningEffort` are those of the
  // run that last wrote the message.
}

export type RunStatus =
  "running" | "finished" | "failed" | "cancelled" | "interrupted";

export interface RunRow {
  id: string;
  session_id: string;
  kind: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  usage: string | null;
  error: string | null;
  model: string | null;
  reasoning_effort: string | null;
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
    return {
      id,
      title,
      created_at: now,
      model: null,
      reasoning_effort: null,
    };
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at, model, reasoning_effort FROM sessions ORDER BY created_at DESC",
      )
      .all() as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare(
        "SELECT id, title, created_at, model, reasoning_effort FROM sessions WHERE id = ?",
      )
      .get(id) as SessionRow | undefined;
  }

  /** Sets the session's choices; a field left out is not changed. */
  setSessionChoices(
    id: string,
    choices: { model?: string | null; reasoningEffort?: string | null },
  ) {
    if (choices.model !== undefined) {
      this.db
        .prepare("UPDATE sessions SET model = ? WHERE id = ?")
        .run(choices.model, id);
    }
    if (choices.reasoningEffort !== undefined) {
      this.db
        .prepare("UPDATE sessions SET reasoning_effort = ? WHERE id = ?")
        .run(choices.reasoningEffort, id);
    }
  }

  addMessage(
    sessionId: string,
    id: string,
    message: Message,
    now: string,
    generation: Generation = NO_GENERATION,
  ) {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, message, created_at, model, reasoning_effort)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        sessionId,
        JSON.stringify(message),
        now,
        generation.model,
        generation.reasoningEffort,
      );
  }

  /**
   * Inserts the message, or replaces it (with its model and effort) if the
   * id exists.
   */
  saveMessage(
    sessionId: string,
    id: string,
    message: Message,
    now: string,
    generation: Generation = NO_GENERATION,
  ) {
    const updated = this.db
      .prepare(
        "UPDATE messages SET message = ?, model = ?, reasoning_effort = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(message),
        generation.model,
        generation.reasoningEffort,
        id,
      );
    if (updated.changes === 0)
      this.addMessage(sessionId, id, message, now, generation);
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
        "SELECT id, message, model, reasoning_effort FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as {
      id: string;
      message: string;
      model: string | null;
      reasoning_effort: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      message: Message.parse(JSON.parse(r.message)),
      model: r.model,
      reasoningEffort: r.reasoning_effort,
    }));
  }

  createRun(run: {
    id: string;
    sessionId: string;
    kind: string;
    now: string;
    generation?: Generation;
  }) {
    const generation = run.generation ?? NO_GENERATION;
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, status, started_at, model, reasoning_effort)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        run.kind,
        run.now,
        generation.model,
        generation.reasoningEffort,
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

  /** Records that the run wrote the message; once per run and message. */
  linkRunMessage(runId: string, messageId: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO run_messages (run_id, message_id, seq)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM run_messages WHERE run_id = ?))`,
      )
      .run(runId, messageId, runId);
  }

  /** The messages the run wrote, in the order it first wrote them. */
  runMessageIds(runId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT message_id FROM run_messages WHERE run_id = ? ORDER BY seq",
        )
        .all(runId) as { message_id: string }[]
    ).map((r) => r.message_id);
  }

  /** Records an "Allow for this session" answer. */
  allowToolForSession(sessionId: string, toolName: string, now: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO session_tool_approvals (session_id, tool_name, created_at) VALUES (?, ?, ?)",
      )
      .run(sessionId, toolName, now);
  }

  isToolAllowedForSession(sessionId: string, toolName: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM session_tool_approvals WHERE session_id = ? AND tool_name = ?",
        )
        .get(sessionId, toolName) !== undefined
    );
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
