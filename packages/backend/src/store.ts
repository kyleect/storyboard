import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  Message,
  Usage,
  type HarnessEvent,
  type StoredEvent,
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
  /** When it was moved to the trash; null when it is not in the trash. */
  trashed_at: string | null;
  /** The project it belongs to; null for a standalone session. */
  project_id: string | null;
  /** 1 when it went to the trash because its project did. */
  trashed_with_project: number;
}

const SESSION_COLUMNS =
  "id, title, created_at, model, reasoning_effort, trashed_at, project_id, trashed_with_project";

/** A session in a list, with how full its context is. */
export interface SessionListRow extends SessionRow {
  /**
   * The usage of the session's latest model call that reported one (its
   * latest message with usage); null when none has.
   */
  usage: Usage | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  /** Empty when there is none. */
  description: string;
  created_at: string;
  /** For the most recently used order (design Q15a). */
  last_used_at: string;
  /** When it was moved to the trash; null when it is not in the trash. */
  trashed_at: string | null;
}

const PROJECT_COLUMNS =
  "id, name, description, created_at, last_used_at, trashed_at";

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
  /**
   * For assistant messages: the usage of the model call that last wrote the
   * message. Null when none was reported, and for other messages.
   */
  usage: Usage | null;
}

const parseUsage = (json: string | null): Usage | null =>
  json === null ? null : Usage.parse(JSON.parse(json));

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
  run_id: string | null;
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

  createSession(
    id: string,
    title: string,
    now: string,
    projectId: string | null = null,
  ): SessionRow {
    this.db
      .prepare(
        "INSERT INTO sessions (id, title, created_at, project_id) VALUES (?, ?, ?, ?)",
      )
      .run(id, title, now, projectId);
    return {
      id,
      title,
      created_at: now,
      model: null,
      reasoning_effort: null,
      trashed_at: null,
      project_id: projectId,
      trashed_with_project: 0,
    };
  }

  /**
   * Sessions that are not in the trash, newest first: the project's, or
   * the standalone sessions when `projectId` is null.
   */
  listSessions(projectId: string | null = null): SessionListRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS},
           (SELECT m.usage FROM messages m
            WHERE m.session_id = sessions.id AND m.usage IS NOT NULL
            ORDER BY m.seq DESC LIMIT 1) AS usage
         FROM sessions
         WHERE trashed_at IS NULL AND project_id IS ?
         ORDER BY created_at DESC`,
      )
      .all(projectId) as (SessionRow & { usage: string | null })[];
    return rows.map((r) => ({ ...r, usage: parseUsage(r.usage) }));
  }

  /**
   * Sessions trashed on their own (not with their project), most recently
   * trashed first.
   */
  listTrashedSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         WHERE trashed_at IS NOT NULL AND trashed_with_project = 0
         ORDER BY trashed_at DESC`,
      )
      .all() as SessionRow[];
  }

  /** The sessions that went to the trash together with the project. */
  listSessionsTrashedWithProject(projectId: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         WHERE project_id = ? AND trashed_with_project = 1
         ORDER BY created_at DESC`,
      )
      .all(projectId) as SessionRow[];
  }

  /** Includes sessions in the trash. */
  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
  }

  renameSession(id: string, title: string) {
    this.db
      .prepare("UPDATE sessions SET title = ? WHERE id = ?")
      .run(title, id);
  }

  /** Moves the session to the trash on its own, or back out with null. */
  setSessionTrashed(id: string, trashedAt: string | null) {
    this.db
      .prepare(
        "UPDATE sessions SET trashed_at = ?, trashed_with_project = 0 WHERE id = ?",
      )
      .run(trashedAt, id);
  }

  /**
   * Permanently deletes a session and every row that belongs to it, in one
   * transaction (design Q6). A new table that references a session, or a
   * session's runs or messages, must be added here.
   */
  purgeSession(id: string) {
    this.db.transaction(() => {
      // Project and global entry versions it made are kept, unlinked.
      this.db
        .prepare(
          "UPDATE entry_versions SET session_id = NULL, run_id = NULL WHERE session_id = ?",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM chunks WHERE scope = 'session' AND owner_id = ?")
        .run(id);
      this.db
        .prepare(
          "DELETE FROM run_messages WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db
        .prepare("DELETE FROM session_tool_approvals WHERE session_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    })();
  }

  /**
   * Purges the sessions trashed on their own, or only those trashed before
   * `before` (an ISO timestamp). Sessions trashed with their project are
   * purged with the project. Returns their ids.
   */
  purgeTrashedSessions(before?: string): string[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE trashed_at IS NOT NULL AND trashed_with_project = 0
         AND (? IS NULL OR trashed_at < ?)`,
      )
      .all(before ?? null, before ?? null) as { id: string }[];
    for (const { id } of ids) this.purgeSession(id);
    return ids.map((r) => r.id);
  }

  createProject(project: {
    id: string;
    name: string;
    description: string;
    now: string;
  }): ProjectRow {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.description,
        project.now,
        project.now,
      );
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      created_at: project.now,
      last_used_at: project.now,
      trashed_at: null,
    };
  }

  /** Includes projects in the trash. */
  getProject(id: string): ProjectRow | undefined {
    return this.db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;
  }

  /** Projects that are not in the trash, most recently used first (Q15). */
  listProjects(): ProjectRow[] {
    return this.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects
         WHERE trashed_at IS NULL ORDER BY last_used_at DESC`,
      )
      .all() as ProjectRow[];
  }

  /** Projects in the trash, most recently trashed first. */
  listTrashedProjects(): ProjectRow[] {
    return this.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects
         WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC`,
      )
      .all() as ProjectRow[];
  }

  /** A field left out is not changed. */
  updateProject(id: string, fields: { name?: string; description?: string }) {
    if (fields.name !== undefined) {
      this.db
        .prepare("UPDATE projects SET name = ? WHERE id = ?")
        .run(fields.name, id);
    }
    if (fields.description !== undefined) {
      this.db
        .prepare("UPDATE projects SET description = ? WHERE id = ?")
        .run(fields.description, id);
    }
  }

  /** Records that the project was used (Q15a). */
  touchProject(id: string, now: string) {
    this.db
      .prepare("UPDATE projects SET last_used_at = ? WHERE id = ?")
      .run(now, id);
  }

  /**
   * Moves the project to the trash, with every session of it that is not
   * already there (Q12). Returns the ids of the sessions moved.
   */
  trashProject(id: string, now: string): string[] {
    return this.db.transaction(() => {
      const ids = (
        this.db
          .prepare(
            "SELECT id FROM sessions WHERE project_id = ? AND trashed_at IS NULL",
          )
          .all(id) as { id: string }[]
      ).map((r) => r.id);
      this.db
        .prepare(
          `UPDATE sessions SET trashed_at = ?, trashed_with_project = 1
           WHERE project_id = ? AND trashed_at IS NULL`,
        )
        .run(now, id);
      this.db
        .prepare("UPDATE projects SET trashed_at = ? WHERE id = ?")
        .run(now, id);
      return ids;
    })();
  }

  /**
   * Takes the project out of the trash. With `sessions: "all"`, the
   * sessions trashed together with it come back too; with "none", they
   * stay in the trash as sessions trashed on their own (Q12b). Sessions
   * trashed before the project stay in the trash either way (Q12c).
   */
  restoreProject(id: string, sessions: "all" | "none") {
    this.db.transaction(() => {
      this.db
        .prepare(
          sessions === "all"
            ? `UPDATE sessions SET trashed_at = NULL, trashed_with_project = 0
               WHERE project_id = ? AND trashed_with_project = 1`
            : `UPDATE sessions SET trashed_with_project = 0
               WHERE project_id = ? AND trashed_with_project = 1`,
        )
        .run(id);
      this.db
        .prepare("UPDATE projects SET trashed_at = NULL WHERE id = ?")
        .run(id);
    })();
  }

  /** Permanently deletes a project and all its sessions. */
  purgeProject(id: string) {
    this.db.transaction(() => {
      const ids = this.db
        .prepare("SELECT id FROM sessions WHERE project_id = ?")
        .all(id) as { id: string }[];
      for (const s of ids) this.purgeSession(s.id);
      this.db
        .prepare(
          "DELETE FROM entry_versions WHERE entry_id IN (SELECT id FROM entries WHERE project_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM entries WHERE project_id = ?").run(id);
      this.db
        .prepare("DELETE FROM chunks WHERE scope = 'project' AND owner_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
  }

  /**
   * Purges the projects in the trash, or only those trashed before
   * `before`, with their sessions. Returns their ids.
   */
  purgeTrashedProjects(before?: string): string[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM projects
         WHERE trashed_at IS NOT NULL AND (? IS NULL OR trashed_at < ?)`,
      )
      .all(before ?? null, before ?? null) as { id: string }[];
    for (const { id } of ids) this.purgeProject(id);
    return ids.map((r) => r.id);
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
    usage: Usage | null = null,
  ) {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, message, created_at, model, reasoning_effort, usage)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        sessionId,
        JSON.stringify(message),
        now,
        generation.model,
        generation.reasoningEffort,
        usage ? JSON.stringify(usage) : null,
      );
  }

  /**
   * Inserts the message, or replaces it (with its model, effort and usage)
   * if the id exists.
   */
  saveMessage(
    sessionId: string,
    id: string,
    message: Message,
    now: string,
    generation: Generation = NO_GENERATION,
    usage: Usage | null = null,
  ) {
    const updated = this.db
      .prepare(
        "UPDATE messages SET message = ?, model = ?, reasoning_effort = ?, usage = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(message),
        generation.model,
        generation.reasoningEffort,
        usage ? JSON.stringify(usage) : null,
        id,
      );
    if (updated.changes === 0)
      this.addMessage(sessionId, id, message, now, generation, usage);
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
        "SELECT id, message, model, reasoning_effort, usage FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as {
      id: string;
      message: string;
      model: string | null;
      reasoning_effort: string | null;
      usage: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      message: Message.parse(JSON.parse(r.message)),
      model: r.model,
      reasoningEffort: r.reasoning_effort,
      usage: parseUsage(r.usage),
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

  /** When each of the session's messages was created, by message id. */
  messageTimes(sessionId: string): Map<string, string> {
    const rows = this.db
      .prepare("SELECT id, created_at FROM messages WHERE session_id = ?")
      .all(sessionId) as { id: string; created_at: string }[];
    return new Map(rows.map((r) => [r.id, r.created_at]));
  }

  /** Which run wrote each of the session's messages (the first run). */
  messageRuns(sessionId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT rm.message_id, rm.run_id FROM run_messages rm
         JOIN runs r ON r.id = rm.run_id
         WHERE r.session_id = ? ORDER BY r.started_at DESC`,
      )
      .all(sessionId) as { message_id: string; run_id: string }[];
    // Later rows (earlier runs) overwrite, so the first run wins.
    return new Map(rows.map((r) => [r.message_id, r.run_id]));
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
