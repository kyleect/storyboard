import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";

/*
 * Agents and their versions (agents design, decisions 2 to 9 and 19 to 25).
 * A project id of null means global. Every save, delete and restore adds a
 * version; the agent row holds the current state. Purging a project removes
 * its agents (`Store.purgeProject`).
 */

export const ToolMode = z.enum(["allow", "deny"]);
export type ToolMode = z.infer<typeof ToolMode>;

/** What a version holds. */
export interface AgentContent {
  name: string;
  /** Empty when there is none. */
  description: string;
  prompt: string;
  /** "allow": only `tools`; "deny": every tool but `tools` (decision 6). */
  toolMode: ToolMode;
  tools: string[];
}

export interface Agent extends AgentContent {
  id: string;
  /** Null: global. */
  projectId: string | null;
  /** The current version's seq. */
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
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
  tool_mode: ToolMode;
  tools: string;
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
  tool_mode: ToolMode;
  tools: string;
  deleted: number;
  created_at: string;
}

const COLUMNS =
  "id, project_id, name, description, prompt, tool_mode, tools, version, created_at, updated_at, deleted_at";

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  toolMode: r.tool_mode,
  tools: JSON.parse(r.tools) as string[],
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
  toolMode: r.tool_mode,
  tools: JSON.parse(r.tools) as string[],
  deleted: r.deleted === 1,
  createdAt: r.created_at,
});

/** Trims the name (decision 4) and removes repeated tool names. */
function normalize(content: AgentContent): AgentContent {
  const name = content.name.trim();
  if (name === "") throw new AgentError("The name is empty.", 400);
  return { ...content, name, tools: [...new Set(content.tools)] };
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
           WHERE project_id IS ? AND (? OR deleted_at IS NULL)
           ORDER BY name`,
        )
        .all(projectId, includeDeleted ? 1 : 0) as AgentRow[]
    ).map(toAgent);
  }

  /** Includes a deleted agent. */
  get(id: string): Agent | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`)
      .get(id) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /** Includes a deleted agent (it keeps its name, decision 4). */
  getByName(projectId: string | null, name: string): Agent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM agents WHERE project_id IS ? AND name = ?`,
      )
      .get(projectId, name) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /**
   * The agents a session can pick (decision 16): live agents of its
   * project, then live global agents.
   */
  pickable(projectId: string | null): Agent[] {
    return [...(projectId ? this.list(projectId) : []), ...this.list(null)];
  }

  /** Whether a session in this project (or none) can use the agent. */
  usableIn(agent: Agent, projectId: string | null): boolean {
    return (
      !agent.deleted &&
      (agent.projectId === null || agent.projectId === projectId)
    );
  }

  create(projectId: string | null, content: AgentContent): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      this.requireFreeName(projectId, c.name, null);
      const id = this.newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO agents (id, project_id, name, description, prompt, tool_mode, tools, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          c.name,
          c.description,
          c.prompt,
          c.toolMode,
          JSON.stringify(c.tools),
          now,
          now,
        );
      this.addVersion(id, 1, c, false, now);
      return this.get(id) as Agent;
    })();
  }

  /** Saves new content as the next version. Refused for a deleted agent. */
  update(id: string, content: AgentContent): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      const agent = this.require(id);
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
  replace(id: string, content: AgentContent): Agent {
    const c = normalize(content);
    return this.db.transaction(() => {
      const agent = this.require(id);
      this.requireFreeName(agent.projectId, c.name, id);
      return this.write(agent, c, false);
    })();
  }

  /**
   * Marks the agent deleted, records the deletion as a version, and clears
   * it from every session that has it picked (decision 23). Returns the
   * sessions cleared.
   */
  delete(id: string): { agent: Agent; sessions: string[] } {
    return this.db.transaction(() => {
      const agent = this.require(id);
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
      return { agent: this.write(agent, agent, true), sessions };
    })();
  }

  /**
   * Makes an earlier version's content the next version; also restores a
   * deleted agent (decisions 21, 22). Sessions are not re-picked.
   */
  restore(id: string, seq: number): Agent {
    return this.db.transaction(() => {
      const agent = this.require(id);
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
          `SELECT seq, name, description, prompt, tool_mode, tools, deleted, created_at
           FROM agent_versions WHERE agent_id = ? ORDER BY seq`,
        )
        .all(id) as VersionRow[]
    ).map(toVersion);
  }

  version(id: string, seq: number): AgentVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT seq, name, description, prompt, tool_mode, tools, deleted, created_at
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
        `UPDATE agents SET name = ?, description = ?, prompt = ?, tool_mode = ?,
           tools = ?, version = ?, updated_at = ?, deleted_at = ?
         WHERE id = ?`,
      )
      .run(
        c.name,
        c.description,
        c.prompt,
        c.toolMode,
        JSON.stringify(c.tools),
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
        `INSERT INTO agent_versions (agent_id, seq, name, description, prompt, tool_mode, tools, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId,
        seq,
        c.name,
        c.description,
        c.prompt,
        c.toolMode,
        JSON.stringify(c.tools),
        deleted ? 1 : 0,
        now,
      );
  }
}
