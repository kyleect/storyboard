import type { Database } from "better-sqlite3-multiple-ciphers";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { activeProfile } from "./profiles.js";

/*
 * Workspaces (files unification design, D22 to D26, D46; workspaces in files
 * design, Q1 to Q7). A workspace is owned by the profile (global), by a
 * project or by a session, and a session uses its own, its project's and the
 * global ones. A temporary workspace is a folder the app made for one session.
 * The disk work is in `workspace-fs.ts`.
 */

/** A refused change, with the HTTP status the route answers. */
export class WorkspaceStoreError extends Error {
  override name = "WorkspaceStoreError";
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Where a workspace is defined, as files are: global, a project or a session. */
export type WorkspaceOwner =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "session"; id: string };

export type WorkspaceScope = WorkspaceOwner["scope"];

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  /** Whether agents may change it; asked per write (D27). */
  writable: boolean;
  scope: WorkspaceScope;
  /** The project or session that owns it; null for global. */
  ownerId: string | null;
  /** A folder the app made for one session, deleted with it (Q4). */
  temporary: boolean;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  /** What is searched: paths inside the folder; "" is all of it (D45, D53). */
  ticks: string[];
  /** Files its .gitignore files ignore are not scanned or shown. */
  respectGitignore: boolean;
}

export interface WorkspaceContent {
  name: string;
  path: string;
  writable: boolean;
  /** Left out: on for a new workspace, as it was for a saved one. */
  respectGitignore?: boolean | undefined;
}

interface Row {
  id: string;
  name: string;
  path: string;
  writable: number;
  project_id: string | null;
  session_id: string | null;
  temporary: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  index_ticks: string;
  respect_gitignore: number;
}

const toRow = (r: Row): WorkspaceRow => ({
  id: r.id,
  name: r.name,
  path: r.path,
  writable: r.writable === 1,
  scope:
    r.session_id !== null
      ? "session"
      : r.project_id !== null
        ? "project"
        : "global",
  ownerId: r.session_id ?? r.project_id,
  temporary: r.temporary === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deleted: r.deleted_at !== null,
  ticks: JSON.parse(r.index_ticks) as string[],
  respectGitignore: r.respect_gitignore === 1,
});

const COLUMNS =
  "id, name, path, writable, project_id, session_id, temporary, created_at, updated_at, deleted_at, index_ticks, respect_gitignore";

/** The SQL that selects the rows one owner defines. */
const OWNED: Record<WorkspaceScope, string> = {
  global: "project_id IS NULL AND session_id IS NULL",
  project: "project_id = ?",
  session: "session_id = ?",
};

const ownerArgs = (owner: WorkspaceOwner): string[] =>
  owner.scope === "global" ? [] : [owner.id];

export class WorkspaceStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    /**
     * Where temporary workspaces are made: a folder in the app's data folder.
     * Left out: none can be made.
     */
    private readonly tempRoot?: string,
  ) {}

  /**
   * The workspaces one owner defines, by name; the trash when asked. A
   * session's own and its project's and the global ones are `forSession`.
   */
  list(owner: WorkspaceOwner, deleted = false): WorkspaceRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM workspaces
           WHERE profile_id = ? AND ${OWNED[owner.scope]}
             AND (deleted_at IS NOT NULL) = ? ORDER BY name`,
        )
        .all(
          activeProfile(this.db),
          ...ownerArgs(owner),
          deleted ? 1 : 0,
        ) as Row[]
    ).map(toRow);
  }

  /** Every live workspace of the profile, whoever owns it. */
  listAll(): WorkspaceRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM workspaces
           WHERE profile_id = ? AND deleted_at IS NULL ORDER BY name`,
        )
        .all(activeProfile(this.db)) as Row[]
    ).map(toRow);
  }

  /** Includes a workspace in the trash. */
  get(id: string): WorkspaceRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM workspaces WHERE profile_id = ? AND id = ?`,
      )
      .get(activeProfile(this.db), id) as Row | undefined;
    return row ? toRow(row) : undefined;
  }

  private require(id: string): WorkspaceRow {
    const row = this.get(id);
    if (!row) throw new WorkspaceStoreError("Workspace not found.", 404);
    return row;
  }

  /** The folder must exist and be a directory; the path is made absolute. */
  private checkFolder(path: string): string {
    const trimmed = path.trim();
    if (trimmed === "" || !isAbsolute(trimmed)) {
      throw new WorkspaceStoreError(
        "The folder must be a full path, such as /Users/you/Notes.",
        400,
      );
    }
    const abs = resolve(trimmed);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new WorkspaceStoreError(`There is no folder at ${abs}.`, 400);
    }
    return abs;
  }

  /** A name is unique within one owner, the trash included (Q3). */
  private checkName(
    name: string,
    owner: WorkspaceOwner,
    self: string | null,
  ): string {
    const clean = name.trim();
    if (clean === "") throw new WorkspaceStoreError("A name is needed.", 400);
    const other = this.db
      .prepare(
        `SELECT id, deleted_at FROM workspaces
         WHERE profile_id = ? AND ${OWNED[owner.scope]} AND name = ?`,
      )
      .get(activeProfile(this.db), ...ownerArgs(owner), clean) as
      { id: string; deleted_at: string | null } | undefined;
    if (other && other.id !== self) {
      throw new WorkspaceStoreError(
        other.deleted_at !== null
          ? `A workspace in the trash is named "${clean}". Restore it or pick another name.`
          : `A workspace named "${clean}" already exists here.`,
        409,
      );
    }
    return clean;
  }

  private insert(
    owner: WorkspaceOwner,
    content: WorkspaceContent,
    temporary: boolean,
    id: string,
  ): WorkspaceRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, profile_id, project_id, session_id, name, path, writable, temporary, created_at, updated_at, respect_gitignore)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        activeProfile(this.db),
        owner.scope === "project" ? owner.id : null,
        owner.scope === "session" ? owner.id : null,
        content.name,
        content.path,
        content.writable ? 1 : 0,
        temporary ? 1 : 0,
        now,
        now,
        content.respectGitignore === false ? 0 : 1,
      );
    return this.require(id);
  }

  create(owner: WorkspaceOwner, content: WorkspaceContent): WorkspaceRow {
    const name = this.checkName(content.name, owner, null);
    const path = this.checkFolder(content.path);
    return this.insert(
      owner,
      {
        name,
        path,
        writable: content.writable,
        ...(content.respectGitignore !== undefined
          ? { respectGitignore: content.respectGitignore }
          : {}),
      },
      false,
      this.newId(),
    );
  }

  /**
   * Makes an empty folder in the app's data folder and a workspace for it,
   * owned by one session (Q4 A). It is writable, like any workspace that is
   * (Q6 A); writes still ask.
   */
  createTemporary(sessionId: string, name: string): WorkspaceRow {
    if (this.tempRoot === undefined) {
      throw new WorkspaceStoreError(
        "Temporary workspaces are not available.",
        501,
      );
    }
    const owner: WorkspaceOwner = { scope: "session", id: sessionId };
    const clean = this.checkName(name, owner, null);
    const id = this.newId();
    const path = join(this.tempRoot, id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      return this.insert(
        owner,
        { name: clean, path, writable: true },
        true,
        id,
      );
    } catch (err) {
      rmSync(path, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * The folder of a temporary workspace is the app's, so it cannot be moved.
   */
  update(id: string, content: WorkspaceContent): WorkspaceRow {
    const existing = this.require(id);
    if (existing.deleted) {
      throw new WorkspaceStoreError(
        "This workspace is in the trash. Restore it first.",
        409,
      );
    }
    const owner = ownerOf(existing);
    const name = this.checkName(content.name, owner, id);
    const path = existing.temporary
      ? existing.path
      : this.checkFolder(content.path);
    this.db
      .prepare(
        `UPDATE workspaces SET name = ?, path = ?, writable = ?, respect_gitignore = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        path,
        content.writable ? 1 : 0,
        (content.respectGitignore ?? existing.respectGitignore) ? 1 : 0,
        this.now(),
        id,
      );
    return this.require(id);
  }

  /** Saves what is searched. The paths are checked by the caller. */
  setTicks(id: string, ticks: readonly string[]): WorkspaceRow {
    this.require(id);
    this.db
      .prepare(
        "UPDATE workspaces SET index_ticks = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(ticks), this.now(), id);
    return this.require(id);
  }

  /** To the trash. Nothing on disk changes (D46). */
  trash(id: string): WorkspaceRow {
    const existing = this.require(id);
    if (!existing.deleted) {
      const now = this.now();
      this.db
        .prepare(
          "UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
    }
    return this.require(id);
  }

  restore(id: string): WorkspaceRow {
    this.require(id);
    this.db
      .prepare(
        "UPDATE workspaces SET deleted_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(this.now(), id);
    return this.require(id);
  }

  /**
   * Deletes a temporary workspace and its folder, after the user said so
   * (Q4 A). A workspace on a folder the user chose goes to the trash instead.
   */
  destroyTemporary(id: string): WorkspaceRow {
    const existing = this.require(id);
    if (!existing.temporary) {
      throw new WorkspaceStoreError(
        "Only a temporary workspace can be deleted. Move this one to the trash instead.",
        409,
      );
    }
    const folders = this.db.transaction(() => dropWorkspaces(this.db, [id]))();
    removeFolders(folders);
    return existing;
  }

  /**
   * A fork gets its own entry for each workspace the source session defined
   * (Q7 A). One on a folder the user chose points at the same folder; a
   * temporary one gets a copy of its folder in a new temporary workspace, so
   * purging one session never removes the other's files. Ticks and "Allow for
   * this session" choices come along; "Always allow" grants are per workspace
   * and do not.
   */
  copySessionWorkspaces(fromSessionId: string, toSessionId: string) {
    const sources = (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM workspaces
           WHERE profile_id = ? AND session_id = ? AND deleted_at IS NULL`,
        )
        .all(activeProfile(this.db), fromSessionId) as Row[]
    ).map(toRow);
    for (const w of sources) {
      const id = this.newId();
      let path = w.path;
      if (w.temporary) {
        if (this.tempRoot === undefined) continue;
        path = join(this.tempRoot, id);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        if (existsSync(w.path)) cpSync(w.path, path, { recursive: true });
      }
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO workspaces
             (id, profile_id, project_id, session_id, name, path, writable, temporary, created_at, updated_at, index_ticks, respect_gitignore)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          activeProfile(this.db),
          toSessionId,
          w.name,
          path,
          w.writable ? 1 : 0,
          w.temporary ? 1 : 0,
          now,
          now,
          JSON.stringify(w.ticks),
          w.respectGitignore ? 1 : 0,
        );
      this.db
        .prepare(
          `INSERT INTO workspace_hidden (workspace_id, scope_kind, scope_id, path)
           SELECT ?, scope_kind, ?, path FROM workspace_hidden
           WHERE workspace_id = ? AND scope_kind = 'session' AND scope_id = ?`,
        )
        .run(id, toSessionId, w.id, fromSessionId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_subject_approvals
             (session_id, tool_name, subject_kind, subject_id, created_at)
           SELECT ?, tool_name, subject_kind, ?, created_at
           FROM session_subject_approvals
           WHERE session_id = ? AND subject_kind = 'workspace' AND subject_id = ?`,
        )
        .run(toSessionId, id, fromSessionId, w.id);
    }
    // What the session hid in workspaces it does not own (global and its
    // project's) is hidden for the fork too.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_hidden (workspace_id, scope_kind, scope_id, path)
         SELECT h.workspace_id, 'session', ?, h.path FROM workspace_hidden h
         JOIN workspaces w ON w.id = h.workspace_id
         WHERE h.scope_kind = 'session' AND h.scope_id = ? AND w.session_id IS NULL`,
      )
      .run(toSessionId, fromSessionId);
  }

  /**
   * The workspaces a session can use: its own, its project's and the global
   * ones, none that is in the trash (Q1 A).
   */
  forSession(sessionId: string, projectId: string | null): WorkspaceRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM workspaces
           WHERE profile_id = ? AND deleted_at IS NULL AND (
             (project_id IS NULL AND session_id IS NULL) OR
             session_id = ? OR project_id = ?)
           ORDER BY name,
             CASE WHEN session_id IS NOT NULL THEN 0
                  WHEN project_id IS NOT NULL THEN 1 ELSE 2 END`,
        )
        .all(activeProfile(this.db), sessionId, projectId ?? "") as Row[]
    ).map(toRow);
  }

  // ---- What a scope hides ---------------------------------------------------

  /** The paths one scope hides in a workspace. */
  hiddenAt(id: string, scope: WorkspaceOwner): string[] {
    return this.hiddenIn(id, [scope]);
  }

  /** The paths hidden by any of these scopes. */
  hiddenIn(id: string, scopes: readonly WorkspaceOwner[]): string[] {
    const out = new Set<string>();
    for (const s of scopes) {
      const rows = this.db
        .prepare(
          "SELECT path FROM workspace_hidden WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ?",
        )
        .all(id, s.scope, s.scope === "global" ? "" : s.id) as {
        path: string;
      }[];
      for (const r of rows) out.add(r.path);
    }
    return [...out].sort();
  }

  /** Replaces what one scope hides in a workspace. */
  setHidden(id: string, scope: WorkspaceOwner, paths: readonly string[]) {
    const scopeId = scope.scope === "global" ? "" : scope.id;
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM workspace_hidden WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ?",
        )
        .run(id, scope.scope, scopeId);
      for (const path of paths) {
        this.db
          .prepare(
            "INSERT INTO workspace_hidden (workspace_id, scope_kind, scope_id, path) VALUES (?, ?, ?, ?)",
          )
          .run(id, scope.scope, scopeId, path);
      }
    })();
  }

  /**
   * What a session does not see of a workspace: what it hid itself and what
   * its project and the global scope hid.
   */
  hiddenForSession(
    id: string,
    sessionId: string,
    projectId: string | null,
  ): string[] {
    return this.hiddenIn(id, [
      { scope: "global" },
      ...(projectId ? [{ scope: "project" as const, id: projectId }] : []),
      { scope: "session", id: sessionId },
    ]);
  }

  // ---- Approvals per subject (D27, D39) -----------------------------------

  /** "Always allow" for a tool and a subject. */
  grantSubject(tool: string, kind: string, subjectId: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_subject_grants (profile_id, tool, subject_kind, subject_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(activeProfile(this.db), tool, kind, subjectId, this.now());
  }

  isSubjectGranted(tool: string, kind: string, subjectId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM tool_subject_grants
           WHERE profile_id = ? AND tool = ? AND subject_kind = ? AND subject_id = ?`,
        )
        .get(activeProfile(this.db), tool, kind, subjectId) !== undefined
    );
  }

  /** The subjects a tool is always allowed for. */
  grantsFor(kind: string): { tool: string; subjectId: string }[] {
    return (
      this.db
        .prepare(
          `SELECT tool, subject_id FROM tool_subject_grants
           WHERE profile_id = ? AND subject_kind = ? ORDER BY tool, subject_id`,
        )
        .all(activeProfile(this.db), kind) as {
        tool: string;
        subject_id: string;
      }[]
    ).map((r) => ({ tool: r.tool, subjectId: r.subject_id }));
  }

  revokeSubject(tool: string, kind: string, subjectId: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM tool_subject_grants
           WHERE profile_id = ? AND tool = ? AND subject_kind = ? AND subject_id = ?`,
        )
        .run(activeProfile(this.db), tool, kind, subjectId).changes > 0
    );
  }

  /** "Allow for this session" for a tool and a subject. */
  allowSubjectForSession(
    sessionId: string,
    tool: string,
    kind: string,
    subjectId: string,
  ) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_subject_approvals
           (session_id, tool_name, subject_kind, subject_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, tool, kind, subjectId, this.now());
  }

  isSubjectAllowedForSession(
    sessionId: string,
    tool: string,
    kind: string,
    subjectId: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM session_subject_approvals
           WHERE session_id = ? AND tool_name = ? AND subject_kind = ? AND subject_id = ?`,
        )
        .get(sessionId, tool, kind, subjectId) !== undefined
    );
  }
}

const ownerOf = (w: WorkspaceRow): WorkspaceOwner =>
  w.scope === "global" || w.ownerId === null
    ? { scope: "global" }
    : { scope: w.scope, id: w.ownerId };

/**
 * Deletes workspaces and everything that points at them: what was indexed,
 * "Always allow" grants and the rows themselves. Returns the folders of the
 * temporary ones, which the caller removes once the transaction is through.
 * A folder the user chose is never touched.
 */
function dropWorkspaces(db: Database, ids: readonly string[]): string[] {
  const folders: string[] = [];
  for (const id of ids) {
    const row = db
      .prepare("SELECT path, temporary FROM workspaces WHERE id = ?")
      .get(id) as { path: string; temporary: number } | undefined;
    if (!row) continue;
    if (row.temporary === 1) folders.push(row.path);
    db.prepare("DELETE FROM workspace_index_files WHERE workspace_id = ?").run(
      id,
    );
    db.prepare("DELETE FROM workspace_hidden WHERE workspace_id = ?").run(id);
    db.prepare(
      "DELETE FROM chunks WHERE scope = 'workspace' AND owner_id = ?",
    ).run(id);
    db.prepare(
      "DELETE FROM tool_subject_grants WHERE subject_kind = 'workspace' AND subject_id = ?",
    ).run(id);
    db.prepare(
      "DELETE FROM session_subject_approvals WHERE subject_kind = 'workspace' AND subject_id = ?",
    ).run(id);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
  return folders;
}

/** Best effort: a folder that is already gone is fine. */
function removeFolders(folders: readonly string[]) {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
}

/**
 * Removes the workspaces a project or session owns, when it is purged. Run in
 * the purge's transaction. Returns the ids, so the index can let go of them,
 * and the temporary folders, to remove after the transaction.
 */
export function purgeWorkspacesOf(
  db: Database,
  kind: "project" | "session",
  ownerId: string,
): { ids: string[]; folders: string[] } {
  const ids = (
    db
      .prepare(
        `SELECT id FROM workspaces WHERE ${kind === "project" ? "project_id" : "session_id"} = ?`,
      )
      .all(ownerId) as { id: string }[]
  ).map((r) => r.id);
  // What this project or session hid in other workspaces goes with it.
  db.prepare(
    "DELETE FROM workspace_hidden WHERE scope_kind = ? AND scope_id = ?",
  ).run(kind, ownerId);

  return { ids, folders: dropWorkspaces(db, ids) };
}

export { removeFolders as removeWorkspaceFolders };
