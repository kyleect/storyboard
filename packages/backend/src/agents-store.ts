import type { Database } from "better-sqlite3-multiple-ciphers";
import { BUILTIN_PROFILE, activeProfile } from "./profiles.js";
import { deleteStoredSettingIf } from "./settings.js";
import { ToolGrant, ToolMode, normalizeGrant } from "./tool-grants.js";

/*
 * Agents and their versions (agents design, decisions 2 to 9 and 19 to 25).
 * A project id of null means global. Every save, delete and restore adds a
 * version; the agent row holds the current state. Purging a project removes
 * its agents (`Store.purgeProject`).
 */

export { ToolMode };

/** What a version holds. */
export interface AgentContent {
  name: string;
  /** Empty when there is none. */
  description: string;
  prompt: string;
  /**
   * Which tools the agent has: groups, exceptions and extras, plus the tools
   * that existed when this version was saved (tool management design,
   * decisions 1, 5, 6, 9).
   */
  toolGrant: ToolGrant;
  /**
   * Tool name to true (ask before each call) or false (don't ask), for the
   * tools this agent has its own say on. A tool not named follows its own
   * setting (agent tool approval design, Q1).
   */
  toolApproval: Record<string, boolean>;
  /**
   * How many reminders a run of this agent as a subagent gets before its
   * last text is taken as its output. Null: the global setting applies.
   */
  childReminders: number | null;
  /**
   * The line added to the end of the system message when this agent runs as
   * a subagent. Null: the global setting applies; empty: no line.
   */
  childPrompt: string | null;
  /** Whether `start_subagent` can start this agent (opt-in). */
  subagent: boolean;
}

/**
 * What a save takes: the subagent settings may be left out, and then the
 * agent does not set them (not startable, global settings).
 */
export type AgentInput = Omit<
  AgentContent,
  "childReminders" | "childPrompt" | "subagent"
> &
  Partial<Pick<AgentContent, "childReminders" | "childPrompt" | "subagent">>;

export interface Agent extends AgentContent {
  id: string;
  /** Null: global. */
  projectId: string | null;
  /** The current version's seq. */
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  /** A built-in agent: read-only, never deleted, global. */
  builtin: boolean;
}

export interface AgentVersion extends AgentContent {
  seq: number;
  /** A deletion; the content is what the agent had then (P9). */
  deleted: boolean;
  createdAt: string;
}

/** A refused change; `statusCode` is used by the server's error handler. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

interface AgentRow {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  prompt: string;
  tool_grant: string;
  tool_approval: string;
  child_reminders: number | null;
  child_prompt: string | null;
  subagent: number;
  builtin: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VersionRow {
  seq: number;
  name: string;
  description: string;
  prompt: string;
  tool_grant: string;
  tool_approval: string;
  child_reminders: number | null;
  child_prompt: string | null;
  subagent: number;
  deleted: number;
  created_at: string;
}

const COLUMNS =
  "id, project_id, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, builtin, version, created_at, updated_at, deleted_at";

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  toolGrant: ToolGrant.parse(JSON.parse(r.tool_grant)),
  toolApproval: JSON.parse(r.tool_approval) as Record<string, boolean>,
  childReminders: r.child_reminders,
  childPrompt: r.child_prompt,
  subagent: r.subagent === 1,
  builtin: r.builtin === 1,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deleted: r.deleted_at !== null,
});

const toVersion = (r: VersionRow): AgentVersion => ({
  seq: r.seq,
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  toolGrant: ToolGrant.parse(JSON.parse(r.tool_grant)),
  toolApproval: JSON.parse(r.tool_approval) as Record<string, boolean>,
  childReminders: r.child_reminders,
  childPrompt: r.child_prompt,
  subagent: r.subagent === 1,
  deleted: r.deleted === 1,
  createdAt: r.created_at,
});

/** Trims the name (decision 4) and removes repeated tool names. */
function normalize(content: AgentInput): AgentContent {
  const name = content.name.trim();
  if (name === "") throw new AgentError("The name is empty.", 400);
  const r = content.childReminders ?? null;
  if (r !== null && (!Number.isInteger(r) || r < 0)) {
    throw new AgentError(
      "The reminders must be a whole number, 0 or more.",
      400,
    );
  }
  return {
    ...content,
    name,
    toolGrant: normalizeGrant(content.toolGrant),
    childReminders: r,
    childPrompt: content.childPrompt ?? null,
    subagent: content.subagent ?? false,
  };
}

export class AgentStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** One scope's agents by name. Deleted ones only when asked. */
  list(projectId: string | null, includeDeleted = false): Agent[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM agents
           WHERE profile_id = ? AND project_id IS ? AND builtin = 0
             AND (? OR deleted_at IS NULL)
           ORDER BY name`,
        )
        .all(
          activeProfile(this.db),
          projectId,
          includeDeleted ? 1 : 0,
        ) as AgentRow[]
    ).map(toAgent);
  }

  /**
   * Includes a deleted agent. An agent of another profile is not found; the
   * built-in ones are shared (profiles design, decision 6).
   */
  get(id: string): Agent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM agents WHERE id = ? AND profile_id IN (?, ?)`,
      )
      .get(id, activeProfile(this.db), BUILTIN_PROFILE) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /** Includes a deleted agent (it keeps its name, decision 4). */
  getByName(projectId: string | null, name: string): Agent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM agents
         WHERE profile_id = ? AND project_id IS ? AND builtin = 0 AND name = ?`,
      )
      .get(activeProfile(this.db), projectId, name) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /** The built-in agents, by name. They cannot be changed or deleted. */
  builtins(): Agent[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM agents WHERE builtin = 1 AND deleted_at IS NULL ORDER BY name`,
        )
        .all() as AgentRow[]
    ).map(toAgent);
  }

  /**
   * The agents a session can pick (decision 16): live agents of its
   * project, then live global agents, then the built-in ones.
   */
  pickable(projectId: string | null): Agent[] {
    return [
      ...(projectId ? this.list(projectId) : []),
      ...this.list(null),
      ...this.builtins(),
    ];
  }

  /** Whether a session in this project (or none) can use the agent. */
  usableIn(agent: Agent, projectId: string | null): boolean {
    return (
      !agent.deleted &&
      (agent.projectId === null || agent.projectId === projectId)
    );
  }

  create(projectId: string | null, content: AgentInput): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      this.requireFreeName(projectId, c.name, null);
      const id = this.newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO agents (id, profile_id, project_id, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          activeProfile(this.db),
          projectId,
          c.name,
          c.description,
          c.prompt,
          JSON.stringify(c.toolGrant),
          JSON.stringify(c.toolApproval),
          c.childReminders,
          c.childPrompt,
          c.subagent ? 1 : 0,
          now,
          now,
        );
      this.addVersion(id, 1, c, false, now);
      return this.get(id) as Agent;
    })();
  }

  /** Saves new content as the next version. Refused for a deleted agent. */
  update(id: string, content: AgentInput): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      const agent = this.requireEditable(id);
      if (agent.deleted) {
        throw new AgentError(
          "The agent is deleted. Restore a version first.",
          409,
        );
      }
      this.requireFreeName(agent.projectId, c.name, id);
      return this.write(agent, c, false);
    })();
  }

  /**
   * Saves content as the next version even when the agent is deleted, which
   * restores it (an import that replaces, decision 28).
   */
  replace(id: string, content: AgentInput): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      const agent = this.requireEditable(id);
      this.requireFreeName(agent.projectId, c.name, id);
      return this.write(agent, c, false);
    })();
  }

  /**
   * Marks the agent deleted, records the deletion as a version, and clears
   * it from every session that has it picked (decision 23). Returns the
   * sessions cleared. Also clears it as any project's default agent, and as
   * the global default.
   */
  delete(id: string): { agent: Agent; sessions: string[] } {
    return this.db.transaction(() => {
      const agent = this.requireEditable(id);
      if (agent.deleted) {
        throw new AgentError("The agent is already deleted.", 409);
      }
      const sessions = (
        this.db
          .prepare("SELECT id FROM sessions WHERE agent_id = ?")
          .all(id) as { id: string }[]
      ).map((r) => r.id);
      this.db
        .prepare("UPDATE sessions SET agent_id = NULL WHERE agent_id = ?")
        .run(id);
      // A deleted agent is no project's default (default agent design,
      // decision 5). Restoring it does not set it again.
      this.db
        .prepare(
          "UPDATE projects SET default_agent_id = NULL WHERE default_agent_id = ?",
        )
        .run(id);
      // Nor the global default (global default agent design, Q7). Restoring
      // it does not set it again.
      deleteStoredSettingIf(this.db, "defaultAgentId", JSON.stringify(id));
      return { agent: this.write(agent, agent, true), sessions };
    })();
  }

  /**
   * Makes an earlier version's content the next version; also restores a
   * deleted agent (decisions 21, 22). Sessions are not re-picked.
   */
  restore(id: string, seq: number): Agent {
    return this.db.transaction(() => {
      const agent = this.requireEditable(id);
      const version = this.version(id, seq);
      if (!version) throw new AgentError(`No version ${seq}.`, 404);
      if (version.deleted) {
        throw new AgentError(
          "That version is a deletion; pick a version with content.",
          400,
        );
      }
      this.requireFreeName(agent.projectId, version.name, id);
      return this.write(agent, version, false);
    })();
  }

  /** Oldest first. */
  versions(id: string): AgentVersion[] {
    return (
      this.db
        .prepare(
          `SELECT seq, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, deleted, created_at
           FROM agent_versions WHERE agent_id = ? ORDER BY seq`,
        )
        .all(id) as VersionRow[]
    ).map(toVersion);
  }

  version(id: string, seq: number): AgentVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT seq, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, deleted, created_at
         FROM agent_versions WHERE agent_id = ? AND seq = ?`,
      )
      .get(id, seq) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  private require(id: string): Agent {
    const agent = this.get(id);
    if (!agent) throw new AgentError("Agent not found.", 404);
    return agent;
  }

  /** Like `require`, for a change: a built-in agent is read-only (409). */
  private requireEditable(id: string): Agent {
    const agent = this.require(id);
    if (agent.builtin) {
      throw new AgentError("A built-in agent cannot be changed.", 409);
    }
    return agent;
  }

  /** 409 when another agent in the scope has the name (decision 4). */
  private requireFreeName(
    projectId: string | null,
    name: string,
    self: string | null,
  ) {
    const other = this.getByName(projectId, name);
    if (other && other.id !== self) {
      throw new AgentError(
        other.deleted
          ? `A deleted agent is named "${name}". Restore it or pick another name.`
          : `An agent named "${name}" already exists here.`,
        409,
      );
    }
  }

  /** Sets the agent's current state and adds it as the next version. */
  private write(agent: Agent, c: AgentContent, deleted: boolean): Agent {
    const now = this.now();
    const seq = agent.version + 1;
    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, prompt = ?,
           tool_grant = ?, tool_approval = ?, child_reminders = ?, child_prompt = ?,
           subagent = ?, version = ?, updated_at = ?,
           deleted_at = ?
         WHERE id = ?`,
      )
      .run(
        c.name,
        c.description,
        c.prompt,
        JSON.stringify(c.toolGrant),
        JSON.stringify(c.toolApproval),
        c.childReminders,
        c.childPrompt,
        c.subagent ? 1 : 0,
        seq,
        now,
        deleted ? now : null,
        agent.id,
      );
    this.addVersion(agent.id, seq, c, deleted, now);
    return this.get(agent.id) as Agent;
  }

  private addVersion(
    agentId: string,
    seq: number,
    c: AgentContent,
    deleted: boolean,
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO agent_versions (agent_id, seq, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId,
        seq,
        c.name,
        c.description,
        c.prompt,
        JSON.stringify(c.toolGrant),
        JSON.stringify(c.toolApproval),
        c.childReminders,
        c.childPrompt,
        c.subagent ? 1 : 0,
        deleted ? 1 : 0,
        now,
      );
  }
}
