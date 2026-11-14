import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  fileNameProblem,
  isInFolder,
  type RunSkill,
  type SkillFileInfo,
  type SkillScope,
} from "@harness/core";
import { parseDocument } from "yaml";
import { getBlob, putBlob, sweepBlobs } from "./blobs.js";
import { ACCEPTED_MEDIA_TYPES, detectMedia } from "./media-detect.js";
import {
  buildSkillFile,
  instructionsOf,
  MAX_DESCRIPTION,
  MAX_NAME,
  parseSkillFile,
  renameInSkillFile,
  SkillFileError,
  skillNameProblem,
} from "./skill-frontmatter.js";

/*
 * Skills as folders (skills folders design). A skill is a folder: a SKILL.md
 * and any other files, global, a project's, or an agent's. Every change adds
 * a version that holds a manifest of the whole folder (`skill_files`); the
 * content of each file is kept once, by hash, in `blobs`, so a file that did
 * not change costs nothing in a new version. The skill row holds the current
 * state. Purging a project removes its skills and those of its agents
 * (`Store.purgeProject`). An agent's skills go with the agent: a deleted
 * agent cannot be picked, so its skills are not in scope, and restoring the
 * agent brings them back.
 */

export { MAX_DESCRIPTION, MAX_NAME };

/** The file every skill has. */
export const SKILL_FILE = "SKILL.md";

/** A binary file keeps this many distinct contents across versions. */
export const BINARY_CONTENTS_KEPT = 3;

/** The caps on a skill folder (decision 11); settings give the real ones. */
export interface SkillLimits {
  /** The most bytes in one file. */
  fileBytes: number;
  /** The most bytes in all the files of one skill. */
  skillBytes: number;
  /** The most files in one skill. */
  files: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  fileBytes: 20 * 1024 * 1024,
  skillBytes: 100 * 1024 * 1024,
  files: 500,
};

/** A file as given to the store. */
export interface SkillFileInput {
  path: string;
  data: Buffer;
}

export interface Skill {
  id: string;
  /** The folder name and the frontmatter `name`; what the model uses. */
  name: string;
  /** From SKILL.md's frontmatter. */
  description: string;
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

/** One file of a version. */
export interface SkillFile extends SkillFileInfo {
  /** The bytes were pruned (a binary file keeps its last three contents). */
  missing: boolean;
  /** The content hash (`/api/blobs/:hash`); null when the bytes were pruned. */
  hash: string | null;
}

export interface SkillVersion {
  seq: number;
  /** The folder name at the time. */
  name: string;
  description: string;
  /** A deletion; the files are what the skill had then. */
  deleted: boolean;
  createdAt: string;
  fileCount: number;
  totalSize: number;
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
  name: string;
  description: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VersionRow {
  seq: number;
  name: string;
  description: string;
  deleted: number;
  created_at: string;
  file_count: number;
  total_size: number;
}

interface FileRow {
  path: string;
  media_type: string;
  size: number;
  blob_hash: string | null;
}

const COLUMNS =
  "id, project_id, agent_id, name, description, version, created_at, updated_at, deleted_at, builtin";

const toSkill = (r: SkillRow): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
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

const toFile = (r: FileRow): SkillFile => ({
  path: r.path,
  mediaType: r.media_type,
  size: r.size,
  missing: r.blob_hash === null,
  hash: r.blob_hash,
});

/** The two owner columns for an owner. */
const columns = (o: SkillOwner): [string | null, string | null] => [
  o.scope === "project" ? o.id : null,
  o.scope === "agent" ? o.id : null,
];

const bad = (message: string) => new SkillError(message, 400);

/** Text, as far as the store can tell: valid UTF-8 with no NUL. */
function asText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

const TEXT_TYPES: [RegExp, string][] = [
  [/\.(md|markdown)$/i, "text/markdown"],
  [/\.json$/i, "application/json"],
];

/**
 * What a file is, from its bytes first and its name second (decision 9):
 * an image or audio format the harness reads, else text, else plain bytes.
 */
export function classifyFile(path: string, data: Buffer): string {
  for (const declared of ACCEPTED_MEDIA_TYPES) {
    const found = detectMedia(declared, data);
    if (found) return found.mediaType;
  }
  if (asText(data) !== undefined) {
    return TEXT_TYPES.find(([re]) => re.test(path))?.[1] ?? "text/plain";
  }
  return "application/octet-stream";
}

/** True for a media type whose bytes are text the store and the model read. */
export const isTextType = (mediaType: string): boolean =>
  mediaType.startsWith("text/") || mediaType === "application/json";

export class SkillStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly limits: () => SkillLimits = () => DEFAULT_SKILL_LIMITS,
  ) {}

  /** The caps in force now (a setting), for what is checked outside the store. */
  currentLimits(): SkillLimits {
    return this.limits();
  }

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

  /** Includes a deleted skill (it keeps its name). */
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

  /** The files of a version (the current one by default), by path. */
  files(id: string, seq?: number): SkillFile[] {
    const skill = this.require(id);
    return (
      this.db
        .prepare(
          `SELECT path, media_type, size, blob_hash FROM skill_files
           WHERE skill_id = ? AND seq = ? ORDER BY path`,
        )
        .all(id, seq ?? skill.version) as FileRow[]
    ).map(toFile);
  }

  /**
   * The bytes of one file in one version (the current one by default).
   * `missing`: the file is in the version but its bytes were pruned.
   */
  readFile(
    id: string,
    path: string,
    seq?: number,
  ):
    | {
        mediaType: string;
        size: number;
        hash: string | null;
        data: Buffer | null;
      }
    | undefined {
    const skill = this.require(id);
    const row = this.db
      .prepare(
        `SELECT path, media_type, size, blob_hash FROM skill_files
         WHERE skill_id = ? AND seq = ? AND path = ?`,
      )
      .get(id, seq ?? skill.version, path) as FileRow | undefined;
    if (!row) return undefined;
    const blob = row.blob_hash ? getBlob(this.db, row.blob_hash) : undefined;
    return {
      mediaType: row.media_type,
      size: row.size,
      hash: row.blob_hash,
      data: blob?.data ?? null,
    };
  }

  /** The text of SKILL.md in a version (the current one by default). */
  skillFileText(id: string, seq?: number): string {
    const file = this.readFile(id, SKILL_FILE, seq);
    return file?.data?.toString("utf-8") ?? "";
  }

  /**
   * The skills a run is given (decision 1): built-in skills, then live global
   * skills, then the live skills of the session's project, then those of its
   * agent. The caller passes no agent for one that is deleted or cannot be
   * used. Each carries the version it was read at, which the run keeps.
   */
  inScope(projectId: string | null, agentId: string | null): RunSkill[] {
    const owners: SkillOwner[] = [
      { scope: "global" },
      ...(projectId ? [{ scope: "project" as const, id: projectId }] : []),
      ...(agentId ? [{ scope: "agent" as const, id: agentId }] : []),
    ];
    return [...this.builtins(), ...owners.flatMap((o) => this.list(o))].map(
      (s): RunSkill => ({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        version: s.version,
        instructions: this.instructionsOf(s),
        files: this.files(s.id).map(({ path, mediaType, size }) => ({
          path,
          mediaType,
          size,
        })),
      }),
    );
  }

  private instructionsOf(skill: Skill): string {
    try {
      return instructionsOf(this.skillFileText(skill.id, skill.version));
    } catch {
      // A SKILL.md that no longer parses has no instructions to give.
      return "";
    }
  }

  /**
   * Makes a skill from a name, a description and instructions: the simple
   * way, for a skill with only a SKILL.md.
   */
  create(
    owner: SkillOwner,
    input: { name: string; description: string; body: string },
  ): Skill {
    const name = input.name.trim();
    const problem = skillNameProblem(name);
    if (problem) throw bad(problem);
    return this.createFromFiles(owner, [
      {
        path: SKILL_FILE,
        data: Buffer.from(
          buildSkillFile(name, input.description, input.body),
          "utf-8",
        ),
      },
    ]);
  }

  /**
   * A copy of a skill's current folder in another owner's scope (an agent
   * copied with its skills). A file whose bytes were pruned is left out.
   */
  copyTo(id: string, owner: SkillOwner): Skill {
    const skill = this.require(id);
    const files = this.manifestOf(id, skill.version).flatMap((e) => {
      const blob = e.hash ? getBlob(this.db, e.hash) : undefined;
      return blob ? [{ path: e.path, data: blob.data }] : [];
    });
    return this.createFromFiles(owner, files);
  }

  /**
   * Makes a skill from a folder of files. Its SKILL.md names the skill; the
   * folder name is that name (decision 2).
   */
  createFromFiles(owner: SkillOwner, files: SkillFileInput[]): Skill {
    const [projectId, agentId] = columns(owner);
    return this.db.transaction(() => {
      const entries = this.prepare(files);
      this.checkCaps(entries);
      const parsed = this.parseEntries(entries);
      this.requireFreeName(owner, parsed.name, null);
      const id = this.newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO skills (id, project_id, agent_id, display_name, name, description, body, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          agentId,
          parsed.name,
          parsed.name,
          parsed.description,
          now,
          now,
        );
      this.addVersion(id, 1, parsed, false, entries, now);
      return this.get(id) as Skill;
    })();
  }

  /**
   * Replaces the whole folder with `files` as the next version, as an import
   * over a skill of the same name does. The SKILL.md must keep the name.
   */
  replaceFiles(id: string, files: SkillFileInput[]): Skill {
    return this.db.transaction(() => {
      const skill = this.requireLive(id);
      const entries = this.prepare(files);
      this.checkCaps(entries);
      const parsed = this.parseEntries(entries);
      this.requireSameName(skill, parsed.name);
      return this.write(skill, parsed, false, entries);
    })();
  }

  /** Saves one file (a new version of the folder). */
  writeFile(id: string, path: string, data: Buffer): Skill {
    const pathProblem = fileNameProblem(path);
    if (pathProblem)
      throw bad(`"${path}" is not a valid name: ${pathProblem}.`);
    return this.db.transaction(() => {
      const skill = this.requireLive(id);
      const kept = this.manifestOf(id, skill.version).filter(
        (e) => e.path !== path,
      );
      const entries = [...kept, ...this.prepare([{ path, data }])];
      this.checkCaps(entries);
      const parsed = this.parseEntries(entries);
      this.requireSameName(skill, parsed.name);
      return this.write(skill, parsed, false, entries);
    })();
  }

  /**
   * Saves a new description and instructions in SKILL.md, keeping every other
   * key of its frontmatter (the simple form's way to save).
   */
  updateText(id: string, input: { description: string; body: string }): Skill {
    const description = input.description.trim();
    if (description === "") throw bad("The description is required.");
    if (description.length > MAX_DESCRIPTION) {
      throw bad(
        `The description is ${description.length} characters; the most is ${MAX_DESCRIPTION}.`,
      );
    }
    const skill = this.requireLive(id);
    const current = this.skillFileText(id, skill.version);
    let text: string;
    try {
      const parsed = parseSkillFile(current);
      const doc = parseDocument(parsed.frontmatter);
      doc.set("description", description);
      const front = doc.toString().trimEnd();
      text = `---\n${front}\n---\n\n${input.body.replace(/^\n+/, "")}`;
    } catch (err) {
      if (err instanceof SkillFileError) throw bad(err.message);
      throw err;
    }
    return this.writeFile(id, SKILL_FILE, Buffer.from(text, "utf-8"));
  }

  /**
   * Moves a file, or every file inside a folder, to a new path (a new
   * version). Nothing may already be at the new path. SKILL.md stays put.
   */
  move(id: string, from: string, to: string): Skill {
    const problem = fileNameProblem(to);
    if (problem) throw bad(`"${to}" is not a valid name: ${problem}.`);
    if (from === SKILL_FILE || isInFolder(SKILL_FILE, from)) {
      throw bad("SKILL.md cannot be moved. Rename the skill instead.");
    }
    if (to === SKILL_FILE)
      throw bad("Only the skill's SKILL.md can be named SKILL.md.");
    return this.db.transaction(() => {
      const skill = this.requireLive(id);
      const files = this.manifestOf(id, skill.version);
      const moving = files.filter((f) => isInFolder(f.path, from));
      if (moving.length === 0)
        throw new SkillError(`Nothing at "${from}".`, 404);
      const moved = moving.map((f) => ({
        ...f,
        path: to + f.path.slice(from.length),
      }));
      for (const m of moved) {
        const problem = fileNameProblem(m.path);
        if (problem) throw bad(`"${m.path}" is not a valid name: ${problem}.`);
      }
      const staying = files.filter((f) => !isInFolder(f.path, from));
      const taken = moved.find((m) => staying.some((s) => s.path === m.path));
      if (taken) throw new SkillError(`"${taken.path}" already exists.`, 409);
      const entries = [...staying, ...moved];
      return this.write(skill, this.parseEntries(entries), false, entries);
    })();
  }

  /** Removes a file, or every file inside a folder (a new version). */
  removePath(id: string, path: string): Skill {
    if (path === SKILL_FILE || isInFolder(SKILL_FILE, path)) {
      throw bad("SKILL.md cannot be deleted. Delete the skill instead.");
    }
    return this.db.transaction(() => {
      const skill = this.requireLive(id);
      const files = this.manifestOf(id, skill.version);
      const entries = files.filter((f) => !isInFolder(f.path, path));
      if (entries.length === files.length) {
        throw new SkillError(`Nothing at "${path}".`, 404);
      }
      return this.write(skill, this.parseEntries(entries), false, entries);
    })();
  }

  /**
   * Renames the skill: the folder name, and the `name` in SKILL.md, which is
   * rewritten to match (decision 4). A new version.
   */
  rename(id: string, name: string): Skill {
    const newName = name.trim();
    const problem = skillNameProblem(newName);
    if (problem) throw bad(problem);
    return this.db.transaction(() => {
      const skill = this.requireLive(id);
      if (newName === skill.name) return skill;
      this.requireFreeName(this.ownerOf(skill), newName, id);
      const renamed = Buffer.from(
        renameInSkillFile(this.skillFileText(id, skill.version), newName),
        "utf-8",
      );
      const entries = [
        ...this.manifestOf(id, skill.version).filter(
          (e) => e.path !== SKILL_FILE,
        ),
        ...this.prepare([{ path: SKILL_FILE, data: renamed }]),
      ];
      return this.write(skill, this.parseEntries(entries), false, entries);
    })();
  }

  /** Marks the skill deleted and records the deletion as a version. */
  delete(id: string): Skill {
    return this.db.transaction(() => {
      const skill = this.requireChangeable(id);
      if (skill.deleted)
        throw new SkillError("The skill is already deleted.", 409);
      const entries = this.manifestOf(id, skill.version);
      return this.write(
        skill,
        { name: skill.name, description: skill.description },
        true,
        entries,
      );
    })();
  }

  /**
   * Makes an earlier version's folder the next version; also restores a
   * deleted skill. The skill keeps its folder name: a version saved under an
   * earlier name has its SKILL.md's `name` set to the current one. A file
   * whose bytes were pruned stays in the folder, shown as missing.
   */
  restore(id: string, seq: number): Skill {
    return this.db.transaction(() => {
      const skill = this.requireChangeable(id);
      const version = this.versionRow(id, seq);
      if (!version) throw new SkillError(`No version ${seq}.`, 404);
      if (version.deleted === 1) {
        throw bad("That version is a deletion; pick a version with content.");
      }
      const entries = this.manifestOf(id, seq);
      const skillFile = entries.find((e) => e.path === SKILL_FILE);
      const bytes = skillFile?.hash
        ? getBlob(this.db, skillFile.hash)
        : undefined;
      if (!skillFile || !bytes) {
        throw bad("That version's SKILL.md is not available to restore.");
      }
      let text = bytes.data.toString("utf-8");
      let parsed;
      try {
        parsed = parseSkillFile(text);
        if (parsed.name !== skill.name) {
          text = renameInSkillFile(text, skill.name);
          parsed = parseSkillFile(text);
        }
      } catch (err) {
        if (err instanceof SkillFileError) throw bad(err.message);
        throw err;
      }
      const data = Buffer.from(text, "utf-8");
      const blob = putBlob(this.db, "text/markdown", data, this.now());
      const next = entries.map((e) =>
        e.path === SKILL_FILE
          ? { ...e, hash: blob.hash, size: data.length }
          : e,
      );
      return this.write(skill, parsed, false, next);
    })();
  }

  /** Oldest first. */
  versions(id: string): SkillVersion[] {
    return (
      this.db
        .prepare(this.versionSelect("WHERE v.skill_id = ? ORDER BY v.seq"))
        .all(id) as VersionRow[]
    ).map(toVersion);
  }

  version(id: string, seq: number): SkillVersion | undefined {
    const row = this.versionRow(id, seq);
    return row ? toVersion(row) : undefined;
  }

  ownerOf(skill: Skill): SkillOwner {
    return skill.agentId !== null
      ? { scope: "agent", id: skill.agentId }
      : skill.projectId !== null
        ? { scope: "project", id: skill.projectId }
        : { scope: "global" };
  }

  // ------------------------------------------------------------- internals

  private versionSelect(where: string): string {
    return `SELECT v.seq, v.name, v.description, v.deleted, v.created_at,
              (SELECT count(*) FROM skill_files f
                 WHERE f.skill_id = v.skill_id AND f.seq = v.seq) AS file_count,
              (SELECT coalesce(sum(f.size), 0) FROM skill_files f
                 WHERE f.skill_id = v.skill_id AND f.seq = v.seq) AS total_size
            FROM skill_versions v ${where}`;
  }

  private versionRow(id: string, seq: number): VersionRow | undefined {
    return this.db
      .prepare(this.versionSelect("WHERE v.skill_id = ? AND v.seq = ?"))
      .get(id, seq) as VersionRow | undefined;
  }

  /** A skill the user can change: not a built-in one (decision 51). */
  private requireChangeable(id: string): Skill {
    const skill = this.require(id);
    if (skill.scope === "builtin") {
      throw new SkillError("Built-in skills can't be changed.", 409);
    }
    return skill;
  }

  /** A skill that can be edited now: changeable and not deleted. */
  private requireLive(id: string): Skill {
    const skill = this.requireChangeable(id);
    if (skill.deleted) {
      throw new SkillError(
        "The skill is deleted. Restore a version first.",
        409,
      );
    }
    return skill;
  }

  private require(id: string): Skill {
    const skill = this.get(id);
    if (!skill) throw new SkillError("Skill not found.", 404);
    return skill;
  }

  /** The folder name cannot change by saving a file: renaming is its own act. */
  private requireSameName(skill: Skill, name: string) {
    if (name !== skill.name) {
      throw bad(
        `The name in SKILL.md ("${name}") must be the skill's name ("${skill.name}"). To rename the skill, rename its folder.`,
      );
    }
  }

  /** 409 when another skill in the scope has the name. */
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

  private manifestOf(id: string, seq: number): Entry[] {
    return (
      this.db
        .prepare(
          `SELECT path, media_type, size, blob_hash FROM skill_files
           WHERE skill_id = ? AND seq = ? ORDER BY path`,
        )
        .all(id, seq) as FileRow[]
    ).map((r) => ({
      path: r.path,
      mediaType: r.media_type,
      size: r.size,
      hash: r.blob_hash,
    }));
  }

  /** Checks each path and size, stores the bytes and describes each file. */
  private prepare(files: SkillFileInput[]): Entry[] {
    const limits = this.limits();
    const seen = new Set<string>();
    return files.map((f): Entry => {
      const problem = fileNameProblem(f.path);
      if (problem) throw bad(`"${f.path}" is not a valid name: ${problem}.`);
      if (seen.has(f.path)) throw bad(`"${f.path}" is in the folder twice.`);
      seen.add(f.path);
      if (f.data.length > limits.fileBytes) {
        throw bad(
          `"${f.path}" is ${mib(f.data.length)}; the most for one file is ${mib(limits.fileBytes)}.`,
        );
      }
      const mediaType = classifyFile(f.path, f.data);
      return {
        path: f.path,
        mediaType,
        size: f.data.length,
        hash: putBlob(this.db, mediaType, f.data, this.now()).hash,
      };
    });
  }

  /** The whole folder against the caps, and a SKILL.md in it. */
  private checkCaps(entries: Entry[]) {
    const limits = this.limits();
    if (entries.length > limits.files) {
      throw bad(
        `A skill can have ${limits.files} files; this one has ${entries.length}.`,
      );
    }
    const total = entries.reduce((n, e) => n + e.size, 0);
    if (total > limits.skillBytes) {
      throw bad(
        `The files come to ${mib(total)}; the most for one skill is ${mib(limits.skillBytes)}.`,
      );
    }
    if (!entries.some((e) => e.path === SKILL_FILE)) {
      throw bad("The skill needs a SKILL.md.");
    }
  }

  /** Reads and checks the SKILL.md among prepared entries. */
  private parseEntries(entries: Entry[]): {
    name: string;
    description: string;
  } {
    const entry = entries.find((e) => e.path === SKILL_FILE);
    const blob = entry?.hash ? getBlob(this.db, entry.hash) : undefined;
    if (!entry || !blob) throw bad("The skill needs a SKILL.md.");
    try {
      const { name, description } = parseSkillFile(blob.data.toString("utf-8"));
      return { name, description };
    } catch (err) {
      if (err instanceof SkillFileError) throw bad(err.message);
      throw err;
    }
  }

  /** Sets the skill's current state and adds it as the next version. */
  private write(
    skill: Skill,
    c: { name: string; description: string },
    deleted: boolean,
    entries: Entry[],
  ): Skill {
    this.checkCaps(entries);
    const now = this.now();
    const seq = skill.version + 1;
    this.db
      .prepare(
        `UPDATE skills SET display_name = ?, name = ?, description = ?,
           version = ?, updated_at = ?, deleted_at = ?
         WHERE id = ?`,
      )
      .run(
        c.name,
        c.name,
        c.description,
        seq,
        now,
        deleted ? now : null,
        skill.id,
      );
    this.addVersion(skill.id, seq, c, deleted, entries, now);
    this.pruneBinaries(skill.id);
    return this.get(skill.id) as Skill;
  }

  private addVersion(
    skillId: string,
    seq: number,
    c: { name: string; description: string },
    deleted: boolean,
    entries: Entry[],
    now: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, seq, display_name, name, description, body, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(skillId, seq, c.name, c.name, c.description, deleted ? 1 : 0, now);
    const insert = this.db.prepare(
      `INSERT INTO skill_files (skill_id, seq, path, media_type, size, blob_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      insert.run(skillId, seq, e.path, e.mediaType, e.size, e.hash);
    }
  }

  /**
   * A binary file keeps its last three distinct contents across versions
   * (decision 10); older versions that used a pruned content keep the file in
   * their manifest, shown as missing. Text is kept in full. Sweeps the blobs
   * nothing points at afterwards.
   */
  private pruneBinaries(skillId: string) {
    const rows = this.db
      .prepare(
        `SELECT path, seq, blob_hash FROM skill_files
         WHERE skill_id = ? AND blob_hash IS NOT NULL
           AND media_type NOT LIKE 'text/%' AND media_type != 'application/json'
         ORDER BY path, seq DESC`,
      )
      .all(skillId) as { path: string; seq: number; blob_hash: string }[];
    const kept = new Map<string, string[]>();
    const drop: { path: string; hash: string }[] = [];
    for (const r of rows) {
      const hashes = kept.get(r.path) ?? [];
      if (hashes.includes(r.blob_hash)) continue;
      if (hashes.length < BINARY_CONTENTS_KEPT) {
        kept.set(r.path, [...hashes, r.blob_hash]);
      } else drop.push({ path: r.path, hash: r.blob_hash });
    }
    if (drop.length === 0) return;
    const clear = this.db.prepare(
      `UPDATE skill_files SET blob_hash = NULL
       WHERE skill_id = ? AND path = ? AND blob_hash = ?`,
    );
    for (const d of drop) clear.run(skillId, d.path, d.hash);
    sweepBlobs(this.db);
  }
}

/** A file of a manifest while a version is being made. */
interface Entry {
  path: string;
  mediaType: string;
  size: number;
  hash: string | null;
}

/** A size for a message: MiB, KiB or bytes, whichever reads best. */
export const mib = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  }
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
  return `${bytes} bytes`;
};

const toVersion = (r: VersionRow): SkillVersion => ({
  seq: r.seq,
  name: r.name,
  description: r.description,
  deleted: r.deleted === 1,
  createdAt: r.created_at,
  fileCount: r.file_count,
  totalSize: r.total_size,
});
