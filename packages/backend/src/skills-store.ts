import type { Database } from "better-sqlite3-multiple-ciphers";
import type { RunSkill, SkillScope } from "@harness/core";

/*
 * Skills and their versions (skills design, decisions 1 to 5, 14 to 23).
 * A skill is global, a project's, or an agent's. Every save, delete and
 * restore adds a version; the skill row holds the current state. Purging a
 * project removes its skills and those of its agents (`Store.purgeProject`).
 * An agent's skills go with the agent: a deleted agent cannot be picked, so
 * its skills are not in scope, and restoring the agent brings them back
 * (decision 21).
 */

/** The longest slug (decision 4). */
export const MAX_SLUG = 64;
/** The longest description (decision 23). */
export const MAX_DESCRIPTION = 1024;

/**
 * The name the model uses, made from the display name (decision 4): accents
 * removed, lowercase, each run of characters that are not letters or digits
 * one "-", none at either end, at most 64 characters. Empty when nothing is
 * left.
 */
export function slugify(displayName: string): string {
  return displayName
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
}

/** What a version holds, as the user enters it. */
export interface SkillContent {
  displayName: string;
  description: string;
  body: string;
}

export interface Skill extends SkillContent {
  id: string;
  /** The slug (decision 4). */
  name: string;
  scope: SkillScope;
  /** Set for a project's skill. */
  projectId: string | null;
  /** Set for an agent's skill. */
  agentId: string | null;
  /** The current version's seq. */
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface SkillVersion extends SkillContent {
  seq: number;
  name: string;
  /** A deletion; the content is what the skill had then. */
  deleted: boolean;
  createdAt: string;
}

/** Where skills live. */
export type SkillOwner =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "agent"; id: string };

/** A refused change; `statusCode` is used by the server's error handler. */
export class SkillError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

interface SkillRow {
  id: string;
  /** 1: a built-in skill (decision 51 of the schemas and data design). */
  builtin: number;
  project_id: string | null;
  agent_id: string | null;
  display_name: string;
  name: string;
  description: string;
  body: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VersionRow {
  seq: number;
  display_name: string;
  name: string;
  description: string;
  body: string;
  deleted: number;
  created_at: string;
}

const COLUMNS =
  "id, project_id, agent_id, display_name, name, description, body, version, created_at, updated_at, deleted_at, builtin";
const VERSION_COLUMNS =
  "seq, display_name, name, description, body, deleted, created_at";

const toSkill = (r: SkillRow): Skill => ({
  id: r.id,
  name: r.name,
  displayName: r.display_name,
  description: r.description,
  body: r.body,
  scope:
    r.builtin === 1
      ? "builtin"
      : r.agent_id !== null
        ? "agent"
        : r.project_id !== null
          ? "project"
          : "global",
  projectId: r.project_id,
  agentId: r.agent_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deleted: r.deleted_at !== null,
});

const toVersion = (r: VersionRow): SkillVersion => ({
  seq: r.seq,
  displayName: r.display_name,
  name: r.name,
  description: r.description,
  body: r.body,
  deleted: r.deleted === 1,
  createdAt: r.created_at,
});

/** The two owner columns for an owner. */
const columns = (o: SkillOwner): [string | null, string | null] => [
  o.scope === "project" ? o.id : null,
  o.scope === "agent" ? o.id : null,
];

/**
 * Checks a skill's content and makes its slug: the display name and
 * description are trimmed and required (decision 14), the description is
 * at most 1,024 characters (decision 23), and the slug must not be empty
 * (decision 4).
 */
function normalize(content: SkillContent): SkillContent & { name: string } {
  const displayName = content.displayName.trim();
  if (displayName === "") throw new SkillError("The name is empty.", 400);
  const description = content.description.trim();
  if (description === "") {
    throw new SkillError("The description is required.", 400);
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new SkillError(
      `The description is ${description.length} characters; the most is ${MAX_DESCRIPTION}.`,
      400,
    );
  }
  const name = slugify(displayName);
  if (name === "") {
    throw new SkillError(
      `The name "${displayName}" has no letters or digits to make a skill name from.`,
      400,
    );
  }
  return { displayName, description, body: content.body, name };
}

export class SkillStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** One owner's skills by name. Deleted ones only when asked. */
  list(owner: SkillOwner, includeDeleted = false): Skill[] {
    const [projectId, agentId] = columns(owner);
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM skills
           WHERE project_id IS ? AND agent_id IS ? AND builtin = 0
             AND (? OR deleted_at IS NULL)
           ORDER BY name`,
        )
        .all(projectId, agentId, includeDeleted ? 1 : 0) as SkillRow[]
    ).map(toSkill);
  }

  /** The skills that come with the app (decision 51), by name. */
  builtins(): Skill[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM skills WHERE builtin = 1 AND deleted_at IS NULL ORDER BY name`,
        )
        .all() as SkillRow[]
    ).map(toSkill);
  }

  /** Includes a deleted skill. */
  get(id: string): Skill | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM skills WHERE id = ?`)
      .get(id) as SkillRow | undefined;
    return row ? toSkill(row) : undefined;
  }

  /** Includes a deleted skill (it keeps its name, decision 3). */
  getByName(owner: SkillOwner, name: string): Skill | undefined {
    const [projectId, agentId] = columns(owner);
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM skills
         WHERE project_id IS ? AND agent_id IS ? AND builtin = 0 AND name = ?`,
      )
      .get(projectId, agentId, name) as SkillRow | undefined;
    return row ? toSkill(row) : undefined;
  }

  /**
   * The skills a run is given (decision 1): live global skills, then the
   * live skills of the session's project, then the live skills of its agent.
   * The caller passes no agent for one that is deleted or cannot be used.
   */
  inScope(projectId: string | null, agentId: string | null): RunSkill[] {
    const owners: SkillOwner[] = [
      { scope: "global" },
      ...(projectId ? [{ scope: "project" as const, id: projectId }] : []),
      ...(agentId ? [{ scope: "agent" as const, id: agentId }] : []),
    ];
    // Built-in skills are in scope everywhere, first (decision 51).
    return [...this.builtins(), ...owners.flatMap((o) => this.list(o))].map(
      (s): RunSkill => ({
        name: s.name,
        displayName: s.displayName,
        description: s.description,
        body: s.body,
        scope: s.scope,
      }),
    );
  }

  create(owner: SkillOwner, content: SkillContent): Skill {
    const c = normalize(content);
    const [projectId, agentId] = columns(owner);
    return this.db.transaction(() => {
      this.requireFreeName(owner, c.name, null);
      const id = this.newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO skills (id, project_id, agent_id, display_name, name, description, body, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          agentId,
          c.displayName,
          c.name,
          c.description,
          c.body,
          now,
          now,
        );
      this.addVersion(id, 1, c, false, now);
      return this.get(id) as Skill;
    })();
  }

  /**
   * Saves new content as the next version; the name follows the display
   * name (decision 5). Refused for a deleted skill.
   */
  update(id: string, content: SkillContent): Skill {
    const c = normalize(content);
    return this.db.transaction(() => {
      const skill = this.requireChangeable(id);
      if (skill.deleted) {
        throw new SkillError(
          "The skill is deleted. Restore a version first.",
          409,
        );
      }
      this.requireFreeName(this.ownerOf(skill), c.name, id);
      return this.write(skill, c, false);
    })();
  }

  /** Marks the skill deleted and records the deletion as a version. */
  delete(id: string): Skill {
    return this.db.transaction(() => {
      const skill = this.requireChangeable(id);
      if (skill.deleted) {
        throw new SkillError("The skill is already deleted.", 409);
      }
      return this.write(skill, { ...skill, name: skill.name }, true);
    })();
  }

  /**
   * Makes an earlier version's content the next version; also restores a
   * deleted skill (decision 16).
   */
  restore(id: string, seq: number): Skill {
    return this.db.transaction(() => {
      const skill = this.requireChangeable(id);
      const version = this.version(id, seq);
      if (!version) throw new SkillError(`No version ${seq}.`, 404);
      if (version.deleted) {
        throw new SkillError(
          "That version is a deletion; pick a version with content.",
          400,
        );
      }
      const c = normalize(version);
      this.requireFreeName(this.ownerOf(skill), c.name, id);
      return this.write(skill, c, false);
    })();
  }

  /** Oldest first. */
  versions(id: string): SkillVersion[] {
    return (
      this.db
        .prepare(
          `SELECT ${VERSION_COLUMNS} FROM skill_versions WHERE skill_id = ? ORDER BY seq`,
        )
        .all(id) as VersionRow[]
    ).map(toVersion);
  }

  version(id: string, seq: number): SkillVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM skill_versions WHERE skill_id = ? AND seq = ?`,
      )
      .get(id, seq) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  ownerOf(skill: Skill): SkillOwner {
    return skill.agentId !== null
      ? { scope: "agent", id: skill.agentId }
      : skill.projectId !== null
        ? { scope: "project", id: skill.projectId }
        : { scope: "global" };
  }

  /** A skill the user can change: not a built-in one (decision 51). */
  private requireChangeable(id: string): Skill {
    const skill = this.require(id);
    if (skill.scope === "builtin") {
      throw new SkillError("Built-in skills can't be changed.", 409);
    }
    return skill;
  }

  private require(id: string): Skill {
    const skill = this.get(id);
    if (!skill) throw new SkillError("Skill not found.", 404);
    return skill;
  }

  /** 409 when another skill in the scope has the name (decision 3). */
  private requireFreeName(
    owner: SkillOwner,
    name: string,
    self: string | null,
  ) {
    const other = this.getByName(owner, name);
    if (other && other.id !== self) {
      throw new SkillError(
        other.deleted
          ? `A deleted skill is named "${name}". Restore it or pick another name.`
          : `A skill named "${name}" already exists here.`,
        409,
      );
    }
  }

  /** Sets the skill's current state and adds it as the next version. */
  private write(
    skill: Skill,
    c: SkillContent & { name: string },
    deleted: boolean,
  ): Skill {
    const now = this.now();
    const seq = skill.version + 1;
    this.db
      .prepare(
        `UPDATE skills SET display_name = ?, name = ?, description = ?, body = ?,
           version = ?, updated_at = ?, deleted_at = ?
         WHERE id = ?`,
      )
      .run(
        c.displayName,
        c.name,
        c.description,
        c.body,
        seq,
        now,
        deleted ? now : null,
        skill.id,
      );
    this.addVersion(skill.id, seq, c, deleted, now);
    return this.get(skill.id) as Skill;
  }

  private addVersion(
    skillId: string,
    seq: number,
    c: SkillContent & { name: string },
    deleted: boolean,
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, seq, display_name, name, description, body, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skillId,
        seq,
        c.displayName,
        c.name,
        c.description,
        c.body,
        deleted ? 1 : 0,
        now,
      );
  }
}
