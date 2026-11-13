import { isBinaryMediaType } from "./messages.js";
import type {
  BlobRef,
  FileOp,
  MediaType,
  Message,
  ModelMessage,
} from "./messages.js";
import { fileNameProblem, isInFolder, parentFolders } from "./file-names.js";

/*
 * Files (files and memory design, section 3).
 *
 * - Files: key/value text written by the user and the model. Notes: text the
 *   model writes for itself, with generated ids.
 * - Three scopes. Session-scoped files are rebuilt from the transcript:
 *   tool results and edit messages carry the changes (decision 11). Project
 *   and global files live in the backend's tables, reached through
 *   `SharedFiles`.
 */

export type Scope = "session" | "project" | "global";
export type SharedScope = Exclude<Scope, "session">;

/** Who made a change, for the version history (decision 8). */
export type FileAuthor =
  | { by: "user"; sessionId?: string }
  | { by: "model"; sessionId: string; runId: string };

/** A project or global file as the backend stores it. */
export interface SharedFile {
  key: string;
  value: string;
  /** Files only. */
  mediaType?: MediaType;
  /** Binary files only: the bytes. `value` is empty then. */
  blob?: BlobRef;
  updatedAt: string;
}

/**
 * Project and global files, implemented by the backend for one session:
 * "project" means that session's project. Deleted files are not returned.
 */
export interface SharedFiles {
  list(scope: SharedScope): SharedFile[];
  get(scope: SharedScope, key: string): SharedFile | undefined;
  put(
    scope: SharedScope,
    file: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
    author: FileAuthor,
  ): void;
  /** False when there was no such file. */
  delete(scope: SharedScope, key: string, author: FileAuthor): boolean;
  /** The explicit folders; folders that only hold files are not listed. */
  listFolders(scope: SharedScope): string[];
  createFolder(scope: SharedScope, path: string): void;
  /** Moves the folder, its explicit subfolders and the files inside it. */
  renameFolder(
    scope: SharedScope,
    from: string,
    to: string,
    author: FileAuthor,
  ): void;
  /** Deletes the folder, its explicit subfolders and the files inside it. */
  deleteFolder(scope: SharedScope, path: string, author: FileAuthor): void;
}

/** Thrown for a bad key, an unavailable scope or an invalid value. */
export class FileError extends Error {
  override name = "FileError";
}

/**
 * The file name rule as a pattern, for forms that ask for a name (tool
 * prompts Q20). A pattern cannot say it all, so this only refuses control
 * characters; `checkFileName` has the full rules (D50).
 */
export const FILE_KEY_PATTERN = "^[^\\u0000-\\u001f\\u007f]+$";

/**
 * A file or folder path: names separated by "/", each following the rules of
 * `file-names.ts` (D50). Case-sensitive and exact (D51).
 */
export function checkFileName(path: string): void {
  const problem = fileNameProblem(path);
  if (problem) {
    throw new FileError(`Invalid file name "${path}": ${problem}.`);
  }
}

/** A value tagged JSON must parse (decision 5). */
export function checkFileValue(mediaType: MediaType, value: string): void {
  if (mediaType !== "application/json") return;
  try {
    JSON.parse(value);
  } catch (err) {
    throw new FileError(
      `The value is tagged json but is not valid JSON: ${(err as Error).message}`,
    );
  }
}

export interface FileInfo {
  scope: Scope;
  key: string;
  mediaType: MediaType;
  /** Length of a text value in characters, or of a binary file in bytes. */
  size: number;
}

export interface FileEntry extends FileInfo {
  /** Empty for a binary file. */
  value: string;
  /** Binary files only: where the bytes are kept. */
  blob?: BlobRef;
}

export interface FolderInfo {
  scope: Scope;
  path: string;
}

/** A search over files in some scopes (decisions 22 to 30). */
export interface SearchQuery {
  query: string;
  scopes: readonly Scope[];
  /** Most hits to return; left out: every match. */
  limit?: number | undefined;
  signal?: AbortSignal;
}

export interface SearchHit {
  scope: Scope;
  /** The file key. */
  key: string;
  /** The matching chunk. */
  excerpt: string;
  /** Which search found it. */
  matched: "keyword" | "meaning" | "both";
}

export interface SearchResult {
  hits: SearchHit[];
  /** "keyword" when no vectors could be used (decision 26). */
  mode: "keyword+meaning" | "keyword";
  /** Why the search was keyword only, when it was. */
  notice?: string;
}

/** Searches files; implemented by the backend for one session. */
export type FileSearch = (query: SearchQuery) => Promise<SearchResult>;

/**
 * One scope, several, or (left out) every scope this session has. Several
 * are listed in the usual order (session, project, global), once each.
 */
export type ScopeFilter = Scope | readonly Scope[];

/** What tools use to reach files (`ToolContext.files`). */
export interface FileAccess {
  /** The scopes this session has: no project scope in a standalone one. */
  readonly scopes: readonly Scope[];
  /** Every scope's files when `scope` is left out (decision 9). */
  listFiles(scope?: ScopeFilter): FileInfo[];
  readFile(scope: Scope, key: string): FileEntry | undefined;
  /**
   * Creates or replaces a text file. Returns true when the file is new. A
   * binary file is added with `putBlob`.
   */
  writeFile(
    scope: Scope,
    key: string,
    mediaType: MediaType,
    value: string,
  ): boolean;
  /**
   * Creates or replaces a binary file whose bytes are already stored.
   * Returns true when the file is new.
   */
  putBlob(
    scope: Scope,
    key: string,
    mediaType: MediaType,
    blob: BlobRef,
  ): boolean;
  deleteFile(scope: Scope, key: string): boolean;
  /** Every folder, explicit or holding files, with the scope it is in. */
  listFolders(scope?: ScopeFilter): FolderInfo[];
  /** False when the folder already exists. */
  createFolder(scope: Scope, path: string): boolean;
  /** Undefined when there is no such folder. */
  renameFolder(
    scope: Scope,
    from: string,
    to: string,
  ): { files: number } | undefined;
  /** Undefined when there is no such folder. */
  deleteFolder(scope: Scope, path: string): { files: number } | undefined;
  /** Every scope when `scope` is left out. */
  search(
    query: string,
    scope: ScopeFilter | undefined,
    /** Left out: every match. */
    limit?: number,
  ): Promise<SearchResult>;
}

interface Current {
  value: string;
  mediaType?: MediaType;
  blob?: BlobRef;
}

/** Current session-scoped files, by key. */
export interface SessionFiles {
  files: Map<string, Current>;
  /** Explicit folders (D6); folders that only hold files are not here. */
  folders: Set<string>;
  /** Every key ever used, including deleted ones (ids are not reused). */
  used: Set<string>;
}

/** The changes a message carries, if any. */
export function messageFileOps(message: Message): readonly FileOp[] {
  if (message.role === "edit") return message.files;
  if (message.role === "tool") return message.files ?? [];
  return [];
}

export function applyFileOp(state: SessionFiles, op: FileOp): void {
  if (op.op === "folder") {
    if (op.action === "create") state.folders.add(op.path);
    else state.folders.delete(op.path);
    return;
  }
  state.used.add(op.key);
  if (op.op === "put") {
    state.files.set(op.key, {
      value: op.value,
      ...(op.mediaType ? { mediaType: op.mediaType } : {}),
      ...(op.blob ? { blob: op.blob } : {}),
    });
  } else {
    state.files.delete(op.key);
  }
}

/** Rebuilds session-scoped files from the transcript. */
export function replaySessionFiles(messages: readonly Message[]): SessionFiles {
  const state: SessionFiles = {
    files: new Map(),
    folders: new Set(),
    used: new Set(),
  };
  for (const m of messages) {
    for (const op of messageFileOps(m)) applyFileOp(state, op);
  }
  return state;
}

/** One version of a session-scoped file, read from the transcript. */
export interface SessionFileVersion {
  /** The message that made the change. */
  messageId: string;
  /** "user" for an edit message, "model" for a tool result. */
  by: "user" | "model";
  op: Exclude<FileOp, { op: "folder" }>;
}

/** Every change to one session-scoped file, oldest first. */
export function sessionFileVersions(
  messages: readonly { id: string; message: Message }[],
  key: string,
): SessionFileVersion[] {
  const out: SessionFileVersion[] = [];
  for (const { id, message } of messages) {
    for (const op of messageFileOps(message)) {
      if (op.op !== "folder" && op.key === key) {
        out.push({
          messageId: id,
          by: message.role === "edit" ? "user" : "model",
          op,
        });
      }
    }
  }
  return out;
}

export interface FileAccessOptions {
  /** Session-scoped files; changed in place by writes. */
  session: SessionFiles;
  /** Session-scoped changes are appended here, to be recorded. */
  sessionOps: FileOp[];
  /** Project and global files. Left out: only session scope exists. */
  shared?: SharedFiles;
  inProject: boolean;
  author: FileAuthor;
  /** Search. Left out: searching fails with a FileError. */
  search?: FileSearch;
}

/** The `FileAccess` a tool gets for one call. */
export function createFileAccess(options: FileAccessOptions): FileAccess {
  const { session, sessionOps, shared, author } = options;
  const scopes: Scope[] = ["session"];
  if (shared && options.inProject) scopes.push("project");
  if (shared) scopes.push("global");

  const requireScope = (scope: Scope) => {
    if (scopes.includes(scope)) return;
    throw new FileError(
      scope === "project"
        ? "This conversation is not in a project, so there is no project scope."
        : `The ${scope} scope is not available.`,
    );
  };
  const listScopes = (scope?: ScopeFilter): Scope[] => {
    if (scope === undefined) return scopes;
    const wanted: readonly Scope[] =
      typeof scope === "string" ? [scope] : scope;
    wanted.forEach(requireScope);
    return scopes.filter((s) => wanted.includes(s));
  };
  const sessionOp = (op: FileOp) => {
    applyFileOp(session, op);
    sessionOps.push(op);
  };
  const get = (scope: Scope, key: string) =>
    scope === "session" ? session.files.get(key) : shared?.get(scope, key);
  const put = (
    scope: Scope,
    file: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
  ) => {
    if (scope === "session") sessionOp({ op: "put", ...file });
    else shared?.put(scope, file, author);
  };
  const remove = (scope: Scope, key: string): boolean => {
    if (scope !== "session") return shared?.delete(scope, key, author) ?? false;
    if (!session.files.has(key)) return false;
    sessionOp({ op: "delete", key });
    return true;
  };
  const liveFileKeys = (scope: Scope): string[] =>
    list(scope).map((e) => e.key);
  /** Explicit folders, plus the folders above every file and folder. */
  const allFolders = (scope: Scope): string[] => {
    const explicit =
      scope === "session"
        ? [...session.folders]
        : (shared?.listFolders(scope) ?? []);
    return [
      ...new Set([
        ...explicit,
        ...explicit.flatMap(parentFolders),
        ...liveFileKeys(scope).flatMap(parentFolders),
      ]),
    ].sort();
  };
  /** True when the file is new; refuses a name that is a folder (D6). */
  const checkNewFile = (scope: Scope, key: string): boolean => {
    const existing = get(scope, key);
    if (existing === undefined) {
      if (allFolders(scope).includes(key)) {
        throw new FileError(`"${key}" is a folder, so it cannot be a file.`);
      }
      const blocking = parentFolders(key).find((p) =>
        liveFileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new FileError(
          `"${blocking}" is a file, so it cannot also be a folder for "${key}".`,
        );
      }
    }
    return existing === undefined;
  };
  const list = (scope: Scope) =>
    scope === "session"
      ? [...session.files].map(([key, c]) => ({ key, ...c }))
      : (shared?.list(scope) ?? []);

  return {
    scopes,
    listFiles: (scope) =>
      listScopes(scope).flatMap((s) =>
        list(s).map((e) => ({
          scope: s,
          key: e.key,
          mediaType: e.mediaType ?? "text/plain",
          size: e.blob?.size ?? e.value.length,
        })),
      ),
    readFile: (scope, key) => {
      requireScope(scope);
      checkFileName(key);
      const e = get(scope, key);
      return e
        ? {
            scope,
            key,
            mediaType: e.mediaType ?? "text/plain",
            size: e.blob?.size ?? e.value.length,
            value: e.value,
            ...(e.blob ? { blob: e.blob } : {}),
          }
        : undefined;
    },
    writeFile: (scope, key, mediaType, value) => {
      requireScope(scope);
      checkFileName(key);
      if (isBinaryMediaType(mediaType)) {
        throw new FileError(
          `${mediaType} is a binary type. Binary files are added by upload, not written as text.`,
        );
      }
      checkFileValue(mediaType, value);
      const isNew = checkNewFile(scope, key);
      put(scope, { key, value, mediaType });
      return isNew;
    },
    putBlob: (scope, key, mediaType, blob) => {
      requireScope(scope);
      checkFileName(key);
      if (!isBinaryMediaType(mediaType)) {
        throw new FileError(`${mediaType} is not a binary type.`);
      }
      const isNew = checkNewFile(scope, key);
      put(scope, { key, value: "", mediaType, blob });
      return isNew;
    },
    deleteFile: (scope, key) => {
      requireScope(scope);
      checkFileName(key);
      return remove(scope, key);
    },
    listFolders: (scope) =>
      listScopes(scope).flatMap((s) =>
        allFolders(s).map((path) => ({ scope: s, path })),
      ),
    createFolder: (scope, path) => {
      requireScope(scope);
      checkFileName(path);
      if (liveFileKeys(scope).includes(path)) {
        throw new FileError(`"${path}" is a file, so it cannot be a folder.`);
      }
      const blocking = parentFolders(path).find((p) =>
        liveFileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new FileError(
          `"${blocking}" is a file, so it cannot also be a folder for "${path}".`,
        );
      }
      if (allFolders(scope).includes(path)) return false;
      if (scope === "session")
        sessionOp({ op: "folder", action: "create", path });
      else shared?.createFolder(scope, path);
      return true;
    },
    renameFolder: (scope, from, to) => {
      requireScope(scope);
      checkFileName(from);
      checkFileName(to);
      if (!allFolders(scope).includes(from)) return undefined;
      if (isInFolder(to, from)) {
        throw new FileError(`A folder cannot be moved into itself.`);
      }
      if (allFolders(scope).includes(to) || liveFileKeys(scope).includes(to)) {
        throw new FileError(`"${to}" already exists.`);
      }
      const blocking = parentFolders(to).find((p) =>
        liveFileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new FileError(
          `"${blocking}" is a file, so it cannot also be a folder for "${to}".`,
        );
      }
      const moved = liveFileKeys(scope).filter((k) => isInFolder(k, from));
      const rename = (path: string) => `${to}${path.slice(from.length)}`;
      if (scope !== "session") {
        shared?.renameFolder(scope, from, to, author);
        return { files: moved.length };
      }
      for (const key of moved) {
        const e = session.files.get(key);
        if (!e) continue;
        sessionOp({
          op: "put",
          key: rename(key),
          value: e.value,
          ...(e.mediaType ? { mediaType: e.mediaType } : {}),
          ...(e.blob ? { blob: e.blob } : {}),
        });
        sessionOp({ op: "delete", key });
      }
      for (const path of [...session.folders].filter((f) =>
        isInFolder(f, from),
      )) {
        sessionOp({ op: "folder", action: "create", path: rename(path) });
        sessionOp({ op: "folder", action: "delete", path });
      }
      // A folder that only held files has no record; keep it as one when empty.
      if (moved.length === 0 && !session.folders.has(to)) {
        sessionOp({ op: "folder", action: "create", path: to });
      }
      return { files: moved.length };
    },
    deleteFolder: (scope, path) => {
      requireScope(scope);
      checkFileName(path);
      if (!allFolders(scope).includes(path)) return undefined;
      const gone = liveFileKeys(scope).filter((k) => isInFolder(k, path));
      if (scope !== "session") {
        shared?.deleteFolder(scope, path, author);
        return { files: gone.length };
      }
      for (const key of gone) {
        sessionOp({ op: "delete", key });
      }
      for (const f of [...session.folders].filter((f) => isInFolder(f, path))) {
        sessionOp({ op: "folder", action: "delete", path: f });
      }
      return { files: gone.length };
    },
    search: async (query, scope, limit) => {
      const scopesToSearch = listScopes(scope);
      if (!options.search) throw new FileError("Search is not available.");
      return options.search({ query, scopes: scopesToSearch, limit });
    },
  };
}

/** The notice the model reads for an edit message (plan P4). */
export function editNotice(ops: readonly FileOp[]): string {
  const parts = ops.map((op) => {
    if (op.op === "folder") {
      return `${op.action === "create" ? "created" : "deleted"} session folder ${op.path}`;
    }
    const what = `file ${op.key}`;
    if (op.op === "put") {
      return `${op.blob ? "added" : "changed"} session ${what}`;
    }
    return `deleted session ${what}`;
  });
  return `[The user ${parts.join("; ")} in the app.]`;
}

/**
 * Turns edit messages into user text for a model. A run of consecutive
 * user and edit messages that includes an edit becomes one user message,
 * so the model never sees two user messages in a row because of an edit
 * (plan P3). Other messages are unchanged.
 */
export function foldEdits(messages: readonly Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let run: {
    items: { content: string; files?: readonly string[] }[];
    hasEdit: boolean;
  } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.hasEdit) {
      // Folded into one message, which keeps every file in order.
      out.push(
        userMessage(
          run.items.map((i) => i.content).join("\n\n"),
          run.items.flatMap((i) => i.files ?? []),
        ),
      );
    } else {
      for (const i of run.items) {
        out.push(userMessage(i.content, i.files));
      }
    }
    run = null;
  };
  for (const m of messages) {
    if (m.role === "user" || m.role === "edit") {
      run ??= { items: [], hasEdit: false };
      run.items.push(
        m.role === "user" && m.files
          ? { content: m.content, files: m.files }
          : { content: m.content },
      );
      if (m.role === "edit") run.hasEdit = true;
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

/** A user message for a model; `files` is left out when there are none. */
function userMessage(
  content: string,
  files: readonly string[] | undefined,
): ModelMessage {
  return files && files.length > 0
    ? { role: "user", content, files: [...files] }
    : { role: "user", content };
}
