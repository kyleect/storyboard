import type { Database } from "better-sqlite3-multiple-ciphers";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/*
 * Workspaces and their attachments (files unification design, D22 to D26,
 * D33, D46). The disk work is in `workspace-fs.ts`.
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

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  writable: boolean;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  /** What is searched: paths inside the folder; "" is all of it (D45, D53). */
  ticks: string[];
}

export interface WorkspaceContent {
  name: string;
  path: string;
  writable: boolean;
}

export type OwnerKind = "project" | "session";

export interface Attachment {
  workspaceId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  readOnly: boolean;
}

/** A workspace as one owner or session uses it. */
export interface AttachedWorkspace extends WorkspaceRow {
  /** Writable in the workspace and by every attachment that applies. */
  effectiveWritable: boolean;
}

interface Row {
  id: string;
  name: string;
  path: string;
  writable: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  index_ticks: string;
}

const toRow = (r: Row): WorkspaceRow => ({
  id: r.id,
  name: r.name,
  path: r.path,
  writable: r.writable === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deleted: r.deleted_at !== null,
  ticks: JSON.parse(r.index_ticks) as string[],
});

const COLUMNS =
  "id, name, path, writable, created_at, updated_at, deleted_at, index_ticks";

export class WorkspaceStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Live workspaces by name; the trash too when asked. */
  list(deleted = false): WorkspaceRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM workspaces
           WHERE (deleted_at IS NOT NULL) = ? ORDER BY name`,
        )
        .all(deleted ? 1 : 0) as Row[]
    ).map(toRow);
  }

  /** Includes a workspace in the trash. */
  get(id: string): WorkspaceRow | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`)
      .get(id) as Row | undefined;
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

  private checkName(name: string, self: string | null): string {
    const clean = name.trim();
    if (clean === "") throw new WorkspaceStoreError("A name is needed.", 400);
    const other = this.db
      .prepare("SELECT id, deleted_at FROM workspaces WHERE name = ?")
      .get(clean) as { id: string; deleted_at: string | null } | undefined;
    if (other && other.id !== self) {
      throw new WorkspaceStoreError(
        other.deleted_at !== null
          ? `A workspace in the trash is named "${clean}". Restore it or pick another name.`
          : `A workspace named "${clean}" already exists.`,
        409,
      );
    }
    return clean;
  }

  create(content: WorkspaceContent): WorkspaceRow {
    const name = this.checkName(content.name, null);
    const path = this.checkFolder(content.path);
    const id = this.newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, writable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, path, content.writable ? 1 : 0, now, now);
    return this.require(id);
  }

  update(id: string, content: WorkspaceContent): WorkspaceRow {
    const existing = this.require(id);
    if (existing.deleted) {
      throw new WorkspaceStoreError(
        "This workspace is in the trash. Restore it first.",
        409,
      );
    }
    const name = this.checkName(content.name, id);
    const path = this.checkFolder(content.path);
    this.db
      .prepare(
        `UPDATE workspaces SET name = ?, path = ?, writable = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, path, content.writable ? 1 : 0, this.now(), id);
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

  attachments(kind: OwnerKind, ownerId: string): Attachment[] {
    return (
      this.db
        .prepare(
          `SELECT workspace_id, read_only FROM workspace_attachments
           WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at, workspace_id`,
        )
        .all(kind, ownerId) as { workspace_id: string; read_only: number }[]
    ).map((r) => ({
      workspaceId: r.workspace_id,
      ownerKind: kind,
      ownerId,
      readOnly: r.read_only === 1,
    }));
  }

  /** Attaches, or changes the read-only choice of an existing attachment. */
  attach(
    kind: OwnerKind,
    ownerId: string,
    workspaceId: string,
    readOnly: boolean,
  ) {
    const ws = this.require(workspaceId);
    if (ws.deleted) {
      throw new WorkspaceStoreError(
        "This workspace is in the trash. Restore it first.",
        409,
      );
    }
    this.db
      .prepare(
        `INSERT INTO workspace_attachments (workspace_id, owner_kind, owner_id, read_only, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, owner_kind, owner_id) DO UPDATE SET read_only = excluded.read_only`,
      )
      .run(workspaceId, kind, ownerId, readOnly ? 1 : 0, this.now());
  }

  /** False when it was not attached. */
  detach(kind: OwnerKind, ownerId: string, workspaceId: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM workspace_attachments
           WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ?`,
        )
        .run(workspaceId, kind, ownerId).changes > 0
    );
  }

  /** Removes an owner's attachments, when the project or session is purged. */
  dropOwner(kind: OwnerKind, ownerId: string) {
    this.db
      .prepare(
        "DELETE FROM workspace_attachments WHERE owner_kind = ? AND owner_id = ?",
      )
      .run(kind, ownerId);
  }

  /**
   * The workspaces a session can use: its project's and its own, none that is
   * in the trash. A workspace attached twice is read-only if either says so
   * (D26, D33).
   */
  forSession(sessionId: string, projectId: string | null): AttachedWorkspace[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ${COLUMNS.split(", ")
          .map((c) => `w.${c}`)
          .join(", ")}
         FROM workspaces w
         JOIN workspace_attachments a ON a.workspace_id = w.id
         WHERE w.deleted_at IS NULL AND (
           (a.owner_kind = 'session' AND a.owner_id = ?) OR
           (a.owner_kind = 'project' AND a.owner_id = ?))
         ORDER BY w.name`,
      )
      .all(sessionId, projectId ?? "") as Row[];
    // Read-only if any attachment that applies says so.
    const readOnly = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT workspace_id FROM workspace_attachments
             WHERE read_only = 1 AND (
               (owner_kind = 'session' AND owner_id = ?) OR
               (owner_kind = 'project' AND owner_id = ?))`,
          )
          .all(sessionId, projectId ?? "") as { workspace_id: string }[]
      ).map((r) => r.workspace_id),
    );
    return rows.map((r) => ({
      ...toRow(r),
      effectiveWritable: r.writable === 1 && !readOnly.has(r.id),
    }));
  }

  // ---- Approvals per subject (D27, D39) -----------------------------------

  /** "Always allow" for a tool and a subject. */
  grantSubject(tool: string, kind: string, subjectId: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_subject_grants (tool, subject_kind, subject_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tool, kind, subjectId, this.now());
  }

  isSubjectGranted(tool: string, kind: string, subjectId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM tool_subject_grants
           WHERE tool = ? AND subject_kind = ? AND subject_id = ?`,
        )
        .get(tool, kind, subjectId) !== undefined
    );
  }

  /** The subjects a tool is always allowed for. */
  grantsFor(kind: string): { tool: string; subjectId: string }[] {
    return (
      this.db
        .prepare(
          `SELECT tool, subject_id FROM tool_subject_grants
           WHERE subject_kind = ? ORDER BY tool, subject_id`,
        )
        .all(kind) as { tool: string; subject_id: string }[]
    ).map((r) => ({ tool: r.tool, subjectId: r.subject_id }));
  }

  revokeSubject(tool: string, kind: string, subjectId: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM tool_subject_grants
           WHERE tool = ? AND subject_kind = ? AND subject_id = ?`,
        )
        .run(tool, kind, subjectId).changes > 0
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
