import type { Database } from "better-sqlite3-multiple-ciphers";
import { sweepBlobs } from "./blobs.js";
import {
  Message,
  Usage,
  type HarnessEvent,
  type StoredEvent,
  type ToolDefinition,
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
  /** The session's chosen agent; null means no agent (agents design 12). */
  agent_id: string | null;
}

/** The title a session gets when none is given. */
export const DEFAULT_TITLE = "New session";

const SESSION_COLUMNS =
  "id, title, created_at, model, reasoning_effort, trashed_at, project_id, trashed_with_project, agent_id";

/**
 * The usage of a session's latest message that reported one, leaving out
 * subagents' messages. For a query over `sessions`.
 */
const LATEST_USAGE = `(SELECT m.usage FROM messages m
            WHERE m.session_id = sessions.id AND m.usage IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM run_messages x JOIN runs xr ON xr.id = x.run_id
                WHERE x.message_id = m.id AND xr.parent_run_id IS NOT NULL)
            ORDER BY m.seq DESC LIMIT 1) AS usage`;

/** A session in a list, with how full its context is. */
export interface SessionListRow extends SessionRow {
  /**
   * The usage of the session's latest model call that reported one (its
   * latest message with usage, leaving out subagents' messages, as the chat
   * header does); null when none has.
   */
  usage: Usage | null;
}

/** A session in the Sessions page's table. */
export interface SessionTableRow extends SessionListRow {
  /** The agents that ran in it, subagents included; empty when none did. */
  agents: { id: string; name: string }[];
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
  /** The agent new sessions start with; null: none (default agent design). */
  default_agent_id: string | null;
  /**
   * Sent after the global system prompt and before the agent's (system
   * prompts design, decision 4). Empty when there is none.
   */
  system_prompt: string;
}

const PROJECT_COLUMNS =
  "id, name, description, created_at, last_used_at, trashed_at, default_agent_id, system_prompt";

/** An agent version a run used (agents design, decisions 13, 14). */
export interface AgentRef {
  id: string;
  version: number;
}

/**
 * What a run sent to the model server, and the agent it ran as; null where
 * nothing was sent or there was no agent.
 */
export interface Generation {
  model: string | null;
  reasoningEffort: string | null;
  agent: AgentRef | null;
}

export const NO_GENERATION: Generation = {
  model: null,
  reasoningEffort: null,
  agent: null,
};

/** An agent version as a message shows it (decision 15). */
export interface MessageAgent extends AgentRef {
  /** The name it had in that version. */
  name: string;
  /** Null: global. */
  projectId: string | null;
}

export interface StoredMessage extends Generation {
  id: string;
  message: Message;
  // For assistant messages, `model`, `reasoningEffort` and `agent` are
  // those of the run that last wrote the message.
  agent: MessageAgent | null;
  /**
   * For assistant messages: the usage of the model call that last wrote the
   * message. Null when none was reported, and for other messages.
   */
  usage: Usage | null;
  /** The run that first wrote the message; null: none (a user message). */
  runId: string | null;
  /**
   * For a message of a subagent's run: the `start_subagent` call that
   * started that run (agent delegation design, decision 40). Null otherwise.
   */
  parentCallId: string | null;
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
  agent_id: string | null;
  agent_version: number | null;
  /** The run whose `start_subagent` call started this one; null: top-level. */
  parent_run_id: string | null;
  parent_call_id: string | null;
  /**
   * The composed system message the run sent; null when the run had none,
   * or was made before it was recorded.
   */
  system_prompt: string | null;
  /** JSON list of the tool definitions the run offered; null as above. */
  tools: string | null;
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
      agent_id: null,
    };
  }

  /**
   * Sessions that are not in the trash, newest first: the project's, or
   * the standalone sessions when `projectId` is null.
   */
  listSessions(projectId: string | null = null): SessionListRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS}, ${LATEST_USAGE}
         FROM sessions
         WHERE trashed_at IS NULL AND project_id IS ?
         ORDER BY created_at DESC`,
      )
      .all(projectId) as (SessionRow & { usage: string | null })[];
    return rows.map((r) => ({ ...r, usage: parseUsage(r.usage) }));
  }

  /**
   * One page of the sessions that are not in the trash (the project's, or
   * the standalone ones when `projectId` is null), ordered by creation time
   * in `direction`. The id breaks ties, so pages do not shift. `total` is
   * the number of such sessions, for the page count.
   */
  listSessionsPage(options: {
    projectId: string | null;
    direction: "asc" | "desc";
    limit: number;
    offset: number;
  }): { items: SessionTableRow[]; total: number } {
    // Not a parameter: a direction cannot be bound. It is one of two words.
    const order = options.direction === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS}, ${LATEST_USAGE}
         FROM sessions
         WHERE trashed_at IS NULL AND project_id IS ?
         ORDER BY created_at ${order}, id ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(options.projectId, options.limit, options.offset) as (SessionRow & {
      usage: string | null;
    })[];
    const { total } = this.db
      .prepare(
        `SELECT count(*) AS total FROM sessions
         WHERE trashed_at IS NULL AND project_id IS ?`,
      )
      .get(options.projectId) as { total: number };
    const agents = this.sessionAgents(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        ...r,
        usage: parseUsage(r.usage),
        agents: agents.get(r.id) ?? [],
      })),
      total,
    };
  }

  /**
   * The agents that ran in each of the sessions, subagents' runs included,
   * by their current name, in the order each first ran. Sessions where no
   * agent ran have no entry.
   */
  private sessionAgents(
    sessionIds: readonly string[],
  ): Map<string, { id: string; name: string }[]> {
    const result = new Map<string, { id: string; name: string }[]>();
    if (sessionIds.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT r.session_id AS session_id, a.id AS id, a.name AS name
         FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE r.session_id IN (${sessionIds.map(() => "?").join(", ")})
         GROUP BY r.session_id, a.id
         ORDER BY min(r.started_at), a.name`,
      )
      .all(...sessionIds) as { session_id: string; id: string; name: string }[];
    for (const row of rows) {
      const list = result.get(row.session_id) ?? [];
      list.push({ id: row.id, name: row.name });
      result.set(row.session_id, list);
    }
    return result;
  }

  /** The ids of every session that is not in the trash, for one project. */
  listSessionIds(projectId: string | null): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM sessions
           WHERE trashed_at IS NULL AND project_id IS ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(projectId) as { id: string }[]
    ).map((r) => r.id);
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

  /**
   * Renames the session only while its title is still the default, so a
   * rename by the user wins (auto-rename plan, decision 10). True when it
   * was renamed.
   */
  renameSessionIfDefault(id: string, title: string): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ?")
        .run(title, id, DEFAULT_TITLE).changes > 0
    );
  }

  /** Moves the session to the trash on its own, or back out with null. */
  setSessionTrashed(id: string, trashedAt: string | null) {
    this.db
      .prepare(
        "UPDATE sessions SET trashed_at = ?, trashed_with_project = 0 WHERE id = ?",
      )
      .run(trashedAt, id);
  }

  /** The user's keep or drop choices for a session's media, by reference. */
  listMediaChoices(sessionId: string): { ref: string; keep: boolean }[] {
    return (
      this.db
        .prepare(
          "SELECT ref, keep FROM media_choices WHERE session_id = ? ORDER BY ref",
        )
        .all(sessionId) as { ref: string; keep: number }[]
    ).map((r) => ({ ref: r.ref, keep: r.keep === 1 }));
  }

  getMediaChoice(sessionId: string, ref: string): boolean | undefined {
    const row = this.db
      .prepare(
        "SELECT keep FROM media_choices WHERE session_id = ? AND ref = ?",
      )
      .get(sessionId, ref) as { keep: number } | undefined;
    return row ? row.keep === 1 : undefined;
  }

  /** Sets the choice; `null` clears it, so the defaults decide again. */
  setMediaChoice(sessionId: string, ref: string, keep: boolean | null) {
    if (keep === null) {
      this.db
        .prepare("DELETE FROM media_choices WHERE session_id = ? AND ref = ?")
        .run(sessionId, ref);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO media_choices (session_id, ref, keep, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, ref) DO UPDATE SET keep = excluded.keep, updated_at = excluded.updated_at`,
      )
      .run(sessionId, ref, keep ? 1 : 0, new Date().toISOString());
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
      // So are the data versions it made (schemas and data design, 24).
      this.db
        .prepare(
          "UPDATE data_versions SET session_id = NULL, run_id = NULL WHERE session_id = ?",
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
      this.db.prepare("DELETE FROM errors WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db
        .prepare("DELETE FROM session_tool_approvals WHERE session_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM media_choices WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      // Frees the bytes of the session's own files (Q10).
      sweepBlobs(this.db);
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
      default_agent_id: null,
      system_prompt: "",
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
  updateProject(
    id: string,
    fields: {
      name?: string;
      description?: string;
      defaultAgentId?: string | null;
      systemPrompt?: string;
    },
  ) {
    if (fields.systemPrompt !== undefined) {
      this.db
        .prepare("UPDATE projects SET system_prompt = ? WHERE id = ?")
        .run(fields.systemPrompt, id);
    }
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
    if (fields.defaultAgentId !== undefined) {
      this.db
        .prepare("UPDATE projects SET default_agent_id = ? WHERE id = ?")
        .run(fields.defaultAgentId, id);
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
      this.db.prepare("DELETE FROM folders WHERE project_id = ?").run(id);
      this.db
        .prepare("DELETE FROM chunks WHERE scope = 'project' AND owner_id = ?")
        .run(id);
      sweepBlobs(this.db);
      // Only the project's sessions can use its agents (agents design 16),
      // and they are purged above (decision 25).
      this.db
        .prepare(
          "DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)",
        )
        .run(id);
      // The project's skills, and those of its agents (skills design,
      // decisions 20, 21), before the agents they point at.
      this.db
        .prepare(
          `DELETE FROM skill_versions WHERE skill_id IN (
             SELECT id FROM skills WHERE project_id = ?
               OR agent_id IN (SELECT id FROM agents WHERE project_id = ?))`,
        )
        .run(id, id);
      this.db
        .prepare(
          `DELETE FROM skills WHERE project_id = ?
             OR agent_id IN (SELECT id FROM agents WHERE project_id = ?)`,
        )
        .run(id, id);
      // The project's schemas and data, and those of its agents (schemas
      // and data design, decision 7). Data made from the project's schemas
      // can only live in the project, its sessions or its agents.
      const owned = `project_id = ?
             OR agent_id IN (SELECT id FROM agents WHERE project_id = ?)`;
      this.db
        .prepare(
          `DELETE FROM data_versions WHERE data_id IN (
             SELECT id FROM data WHERE ${owned}
               OR schema_id IN (SELECT id FROM schemas WHERE ${owned}))`,
        )
        .run(id, id, id, id);
      this.db
        .prepare(
          `DELETE FROM data WHERE ${owned}
             OR schema_id IN (SELECT id FROM schemas WHERE ${owned})`,
        )
        .run(id, id, id, id);
      this.db
        .prepare(
          `DELETE FROM schema_versions WHERE schema_id IN (
             SELECT id FROM schemas WHERE ${owned})`,
        )
        .run(id, id);
      this.db.prepare(`DELETE FROM schemas WHERE ${owned}`).run(id, id);
      // The project's default may be one of its own agents; let go of it
      // first so the foreign key doesn't block the delete.
      this.db
        .prepare("UPDATE projects SET default_agent_id = NULL WHERE id = ?")
        .run(id);
      this.db.prepare("DELETE FROM agents WHERE project_id = ?").run(id);
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
    choices: {
      model?: string | null;
      reasoningEffort?: string | null;
      agentId?: string | null;
    },
  ) {
    if (choices.agentId !== undefined) {
      this.db
        .prepare("UPDATE sessions SET agent_id = ? WHERE id = ?")
        .run(choices.agentId, id);
    }
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
        `INSERT INTO messages (id, session_id, seq, message, created_at, model, reasoning_effort, usage, agent_id, agent_version)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?, ?, ?, ?, ?)`,
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
        generation.agent?.id ?? null,
        generation.agent?.version ?? null,
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
        "UPDATE messages SET message = ?, model = ?, reasoning_effort = ?, usage = ?, agent_id = ?, agent_version = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(message),
        generation.model,
        generation.reasoningEffort,
        usage ? JSON.stringify(usage) : null,
        generation.agent?.id ?? null,
        generation.agent?.version ?? null,
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

  /**
   * The tokens the session's subagent runs used, summed over every model
   * call of every subagent run that has ended (a run's usage is saved when
   * it ends). Null when no subagent run reported usage. This is work done,
   * not context occupancy: each call's prompt counts again.
   */
  subagentUsage(sessionId: string): Usage | null {
    const rows = this.db
      .prepare(
        `SELECT usage FROM runs
         WHERE session_id = ? AND parent_run_id IS NOT NULL AND usage IS NOT NULL`,
      )
      .all(sessionId) as { usage: string }[];
    if (rows.length === 0) return null;
    return rows.reduce<Usage>(
      (sum, r) => {
        const u = parseUsage(r.usage);
        return u
          ? {
              promptTokens: sum.promptTokens + u.promptTokens,
              completionTokens: sum.completionTokens + u.completionTokens,
            }
          : sum;
      },
      { promptTokens: 0, completionTokens: 0 },
    );
  }

  /**
   * The session's messages in order. By default all of them, including those
   * of subagents' runs. `"top"`: only those a top-level run sees, leaving
   * out every subagent run's messages. `{ run }`: only those the run wrote
   * (a subagent's request, decision 29).
   */
  listMessages(
    sessionId: string,
    only?: "top" | { run: string },
  ): StoredMessage[] {
    const filter =
      only === undefined
        ? ""
        : only === "top"
          ? `AND NOT EXISTS (
               SELECT 1 FROM run_messages x JOIN runs xr ON xr.id = x.run_id
               WHERE x.message_id = m.id AND xr.parent_run_id IS NOT NULL)`
          : `AND EXISTS (
               SELECT 1 FROM run_messages x
               WHERE x.message_id = m.id AND x.run_id = @run)`;
    const rows = this.db
      .prepare(
        `SELECT m.id, m.message, m.model, m.reasoning_effort, m.usage,
           m.agent_id, m.agent_version, v.name AS agent_name, a.project_id AS agent_project_id,
           (SELECT rm.run_id FROM run_messages rm JOIN runs r ON r.id = rm.run_id
              WHERE rm.message_id = m.id ORDER BY r.started_at, r.rowid LIMIT 1) AS run_id,
           (SELECT r.parent_call_id FROM run_messages rm JOIN runs r ON r.id = rm.run_id
              WHERE rm.message_id = m.id ORDER BY r.started_at, r.rowid LIMIT 1) AS parent_call_id
         FROM messages m
         LEFT JOIN agent_versions v ON v.agent_id = m.agent_id AND v.seq = m.agent_version
         LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.session_id = @session ${filter} ORDER BY m.seq`,
      )
      .all({
        session: sessionId,
        ...(typeof only === "object" ? { run: only.run } : {}),
      }) as {
      id: string;
      message: string;
      model: string | null;
      reasoning_effort: string | null;
      usage: string | null;
      agent_id: string | null;
      agent_version: number | null;
      agent_name: string | null;
      agent_project_id: string | null;
      run_id: string | null;
      parent_call_id: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      message: Message.parse(JSON.parse(r.message)),
      model: r.model,
      reasoningEffort: r.reasoning_effort,
      agent:
        r.agent_id !== null && r.agent_version !== null
          ? {
              id: r.agent_id,
              version: r.agent_version,
              name: r.agent_name ?? "",
              projectId: r.agent_project_id,
            }
          : null,
      usage: parseUsage(r.usage),
      runId: r.run_id,
      parentCallId: r.parent_call_id,
    }));
  }

  createRun(run: {
    id: string;
    sessionId: string;
    kind: string;
    now: string;
    generation?: Generation;
    /** For a subagent's run: the run and call that started it. */
    parent?: { runId: string; callId: string };
    /** What the run sends to the model, kept for debugging. */
    request?: { systemPrompt?: string; tools?: readonly ToolDefinition[] };
  }) {
    const generation = run.generation ?? NO_GENERATION;
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, status, started_at, model, reasoning_effort, agent_id, agent_version, parent_run_id, parent_call_id, system_prompt, tools)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        run.kind,
        run.now,
        generation.model,
        generation.reasoningEffort,
        generation.agent?.id ?? null,
        generation.agent?.version ?? null,
        run.parent?.runId ?? null,
        run.parent?.callId ?? null,
        run.request?.systemPrompt ?? null,
        run.request?.tools ? JSON.stringify(run.request.tools) : null,
      );
  }

  /** The session's runs, oldest first. */
  listRuns(sessionId: string): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE session_id = ? ORDER BY started_at, rowid",
      )
      .all(sessionId) as RunRow[];
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
