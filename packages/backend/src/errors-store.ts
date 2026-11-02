import type { Database } from "better-sqlite3-multiple-ciphers";

/*
 * Errors for the errors consoles (error reporting plan, P4): tool errors
 * and failed runs. A session's errors are removed when it is purged
 * (`Store.purgeSession`) or cleared; errors of sessions in the trash are
 * left out of every list.
 */

export type ErrorSource = "tool" | "run";

export type ErrorKind =
  | "tool_threw"
  | "tool_returned_error"
  | "unknown_tool"
  | "invalid_arguments"
  | "malformed_call"
  | "run_failed";

/** An error to record. */
export interface NewError {
  sessionId: string;
  runId: string | null;
  messageId?: string | null;
  callId?: string | null;
  source: ErrorSource;
  kind: ErrorKind;
  toolName?: string | null;
  message: string;
  details?: Record<string, unknown> | undefined;
  stack?: string | undefined;
  arguments?: unknown;
}

/** A recorded error, as the API returns it. */
export interface ErrorEntry {
  id: string;
  sessionId: string;
  sessionTitle: string;
  /** Null: a standalone session. */
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
  /** The tool result message, for the link to the transcript. */
  messageId: string | null;
  callId: string | null;
  source: ErrorSource;
  kind: ErrorKind;
  toolName: string | null;
  message: string;
  /** What the tool gave; null when none. */
  details: Record<string, unknown> | null;
  stack: string | null;
  /** The call's arguments; null for a failed run. */
  arguments: unknown;
  createdAt: string;
}

/** Narrows a list. `projectId: null` means standalone sessions. */
export interface ErrorFilter {
  sessionId?: string;
  projectId?: string | null;
  source?: ErrorSource;
  toolName?: string;
}

/** The values the filters can take: those that have errors now. */
export interface ErrorFilterOptions {
  sessions: { id: string; title: string; projectId: string | null }[];
  projects: { id: string; name: string }[];
  tools: string[];
  /** Whether there are failed runs. */
  runs: boolean;
}

interface Row {
  id: string;
  session_id: string;
  session_title: string;
  project_id: string | null;
  project_name: string | null;
  run_id: string | null;
  message_id: string | null;
  call_id: string | null;
  source: ErrorSource;
  kind: ErrorKind;
  tool_name: string | null;
  message: string;
  details: string | null;
  created_at: string;
}

interface Stored {
  details?: Record<string, unknown>;
  stack?: string;
  arguments?: unknown;
}

/** Errors of sessions not in the trash, with their session and project. */
const FROM = `FROM errors e
  JOIN sessions s ON s.id = e.session_id
  LEFT JOIN projects p ON p.id = s.project_id
  WHERE s.trashed_at IS NULL`;

export class ErrorStore {
  constructor(
    readonly db: Database,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Records an error; returns its id. */
  record(error: NewError, now: string): string {
    const id = this.newId();
    const stored: Stored = {
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error.arguments !== undefined ? { arguments: error.arguments } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO errors (id, session_id, run_id, message_id, call_id, source, kind, tool_name, message, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        error.sessionId,
        error.runId,
        error.messageId ?? null,
        error.callId ?? null,
        error.source,
        error.kind,
        error.toolName ?? null,
        error.message,
        Object.keys(stored).length > 0 ? JSON.stringify(stored) : null,
        now,
      );
    return id;
  }

  /** Errors of sessions not in the trash, newest first. */
  list(filter: ErrorFilter = {}): ErrorEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId !== undefined) {
      where.push("e.session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.projectId !== undefined) {
      if (filter.projectId === null) where.push("s.project_id IS NULL");
      else {
        where.push("s.project_id = ?");
        params.push(filter.projectId);
      }
    }
    if (filter.source !== undefined) {
      where.push("e.source = ?");
      params.push(filter.source);
    }
    if (filter.toolName !== undefined) {
      where.push("e.tool_name = ?");
      params.push(filter.toolName);
    }
    const rows = this.db
      .prepare(
        `SELECT e.id, e.session_id, s.title AS session_title, s.project_id,
                p.name AS project_name, e.run_id, e.message_id, e.call_id,
                e.source, e.kind, e.tool_name, e.message, e.details, e.created_at
         ${FROM}${where.map((w) => ` AND ${w}`).join("")}
         ORDER BY e.created_at DESC, e.rowid DESC`,
      )
      .all(...params) as Row[];
    return rows.map(toEntry);
  }

  /** The sessions, projects and tools that have errors now. */
  filterOptions(): ErrorFilterOptions {
    const sessions = this.db
      .prepare(
        `SELECT DISTINCT s.id, s.title, s.project_id ${FROM} ORDER BY s.title, s.id`,
      )
      .all() as { id: string; title: string; project_id: string | null }[];
    const projects = this.db
      .prepare(
        `SELECT DISTINCT p.id, p.name ${FROM} AND p.id IS NOT NULL ORDER BY p.name, p.id`,
      )
      .all() as { id: string; name: string }[];
    const tools = this.db
      .prepare(
        `SELECT DISTINCT e.tool_name ${FROM} AND e.tool_name IS NOT NULL ORDER BY e.tool_name`,
      )
      .all() as { tool_name: string }[];
    const runs = this.db
      .prepare(`SELECT 1 ${FROM} AND e.source = 'run' LIMIT 1`)
      .get();
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        projectId: s.project_id,
      })),
      projects,
      tools: tools.map((t) => t.tool_name),
      runs: runs !== undefined,
    };
  }

  /**
   * Deletes one session's errors, or, when `sessionId` is left out, every
   * error the global console holds, whatever filters it shows (O2). Errors
   * of sessions in the trash are not shown there, so they are kept, and come
   * back if the session is restored. Returns how many were deleted.
   */
  clear(sessionId?: string): number {
    const result =
      sessionId === undefined
        ? this.db
            .prepare(
              "DELETE FROM errors WHERE session_id IN (SELECT id FROM sessions WHERE trashed_at IS NULL)",
            )
            .run()
        : this.db
            .prepare("DELETE FROM errors WHERE session_id = ?")
            .run(sessionId);
    return result.changes;
  }
}

function toEntry(row: Row): ErrorEntry {
  const stored = row.details ? (JSON.parse(row.details) as Stored) : {};
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    projectId: row.project_id,
    projectName: row.project_name,
    runId: row.run_id,
    messageId: row.message_id,
    callId: row.call_id,
    source: row.source,
    kind: row.kind,
    toolName: row.tool_name,
    message: row.message,
    details: stored.details ?? null,
    stack: stored.stack ?? null,
    arguments: stored.arguments ?? null,
    createdAt: row.created_at,
  };
}
