/*
 * Workspaces (files unification design, D22 to D36): named folders on the
 * computer that a project or session can attach, read-only or writable. A
 * workspace file is named by a reference, `workspace://<id>/path`. The tools
 * reach them only through `WorkspaceAccess`, which the backend implements:
 * the backend decides what is attached, resolves paths safely and does the
 * disk work.
 */

/** A workspace as a session sees it. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /**
   * Whether it can be changed in this session: the workspace is writable and
   * no attachment of it (project or session) makes it read-only (D26).
   */
  writable: boolean;
}

/** An approval is asked and remembered per tool and subject (D27, D39). */
export interface ApprovalSubject {
  kind: "workspace";
  id: string;
  /** Shown in the approval prompt, such as the workspace's name. */
  label: string;
}

export type WorkspaceErrorCode =
  | "not_found"
  | "exists"
  | "read_only"
  /** The path leaves the workspace folder, by `..` or a symlink (D28). */
  | "outside"
  /** The file changed on disk since it was read, or was not read (D32). */
  | "stale"
  | "invalid"
  | "too_large"
  | "not_text"
  | "not_empty"
  | "unavailable";

/** A refused workspace operation; the tool turns it into its result. */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    /** For `outside`: the path the call would reach, to ask the user about. */
    readonly target?: string,
  ) {
    super(message);
  }
}

export interface WorkspaceEntry {
  /** The path inside the workspace, folders separated by `/`. */
  path: string;
  kind: "file" | "folder";
  /** Files only, in bytes. */
  size?: number;
  modifiedAt: string;
  /** Files only; undefined when the content is not text, image or audio. */
  mediaType?: string;
}

/** What reading a workspace file gives. */
export type WorkspaceRead =
  | {
      kind: "text";
      mediaType: string;
      /** The part read: from `offset`, at most the read cap or `limit`. */
      text: string;
      offset: number;
      /** The file's length in characters. */
      total: number;
    }
  | { kind: "media"; mediaType: string; size: number }
  | { kind: "binary"; size: number };

export interface WorkspaceOptions {
  /** Allow this one path outside the folder, after the user said so (D28). */
  allowOutside?: boolean;
}

/** A match in a workspace's indexed files (D45). */
export interface WorkspaceHit {
  workspace: WorkspaceInfo;
  /** The path inside the workspace. */
  path: string;
  /** The best matching part of the file. */
  excerpt: string;
  matched: "keyword" | "meaning" | "both";
}

export interface WorkspaceSearchResult {
  hits: WorkspaceHit[];
  /** "keyword" when meaning search was not possible; see `notice`. */
  mode: "keyword+meaning" | "keyword";
  notice?: string;
  /** How many files of each workspace are searchable now. */
  indexed: { workspace: WorkspaceInfo; files: number }[];
}

export interface WorkspaceAccess {
  /** The workspaces this session can use. */
  list(): WorkspaceInfo[];
  /**
   * Reads a reference, `workspace://<id>/path`, or a plain path when exactly
   * one workspace is attached. The path is relative to the workspace, with
   * no leading `/`; the root is the empty string.
   */
  locate(
    text: string,
  ): { workspace: WorkspaceInfo; path: string } | { error: string };
  /** The most characters one read returns (a setting, D47, D55). */
  readCap: number;
  listDir(
    id: string,
    path: string,
    options?: WorkspaceOptions & { recursive?: boolean },
  ): Promise<WorkspaceEntry[]>;
  read(
    id: string,
    path: string,
    options?: WorkspaceOptions & { offset?: number; limit?: number },
  ): Promise<WorkspaceRead>;
  /** Creates or replaces a text file; parent folders are made. */
  write(
    id: string,
    path: string,
    content: string,
    options?: WorkspaceOptions,
  ): Promise<{ created: boolean; size: number }>;
  /** Replaces text in a file that was read. */
  edit(
    id: string,
    path: string,
    oldText: string,
    newText: string,
    options?: WorkspaceOptions & { replaceAll?: boolean },
  ): Promise<{ replacements: number }>;
  /** Renames or moves a file within the workspace; it never overwrites. */
  move(
    id: string,
    from: string,
    to: string,
    options?: WorkspaceOptions,
  ): Promise<void>;
  /** Deletes a file. */
  remove(id: string, path: string, options?: WorkspaceOptions): Promise<void>;
  /** False when the folder is already there. */
  createFolder(
    id: string,
    path: string,
    options?: WorkspaceOptions,
  ): Promise<boolean>;
  /** Renames or moves a folder within the workspace. */
  moveFolder(
    id: string,
    from: string,
    to: string,
    options?: WorkspaceOptions,
  ): Promise<void>;
  /**
   * Searches the parts of the session's workspaces the user chose to index,
   * by keyword and by meaning (D45).
   */
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchResult>;
  /** A folder with files in it needs `recursive`. Returns the files removed. */
  deleteFolder(
    id: string,
    path: string,
    options?: WorkspaceOptions & { recursive?: boolean },
  ): Promise<{ files: number }>;
}

/** A session with no workspaces. */
export const NO_WORKSPACES: WorkspaceAccess = {
  list: () => [],
  locate: () => ({ error: "This session has no workspaces." }),
  readCap: 10_000,
  listDir: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  read: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  write: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  edit: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  move: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  remove: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  createFolder: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  moveFolder: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  deleteFolder: () => Promise.reject(new WorkspaceError("unavailable", "none")),
  search: () => Promise.reject(new WorkspaceError("unavailable", "none")),
};

/** The most characters one workspace read returns, by default (D55). */
export const DEFAULT_WORKSPACE_READ_CAP = 10_000;
