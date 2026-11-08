import { isBinaryMediaType } from "./messages.js";
import type {
  BlobRef,
  EntryKind,
  EntryOp,
  MediaType,
  Message,
  ModelMessage,
} from "./messages.js";
import { fileNameProblem, isInFolder, parentFolders } from "./file-names.js";

/*
 * Files and memory notes (files and memory design, section 3).
 *
 * - Files: key/value text written by the user and the model. Notes: text the
 *   model writes for itself, with generated ids.
 * - Three scopes. Session-scoped entries are rebuilt from the transcript:
 *   tool results and edit messages carry the changes (decision 11). Project
 *   and global entries live in the backend's tables, reached through
 *   `SharedEntries`.
 */

export type Scope = "session" | "project" | "global";
export type SharedScope = Exclude<Scope, "session">;

/** Who made a change, for the version history (decision 8). */
export type EntryAuthor =
  | { by: "user"; sessionId?: string }
  | { by: "model"; sessionId: string; runId: string };

/** A project or global entry as the backend stores it. */
export interface SharedEntry {
  key: string;
  value: string;
  /** Files only. */
  mediaType?: MediaType;
  /** Binary files only: the bytes. `value` is empty then. */
  blob?: BlobRef;
  updatedAt: string;
}

/**
 * Project and global entries, implemented by the backend for one session:
 * "project" means that session's project. Deleted entries are not returned.
 */
export interface SharedEntries {
  list(kind: EntryKind, scope: SharedScope): SharedEntry[];
  get(
    kind: EntryKind,
    scope: SharedScope,
    key: string,
  ): SharedEntry | undefined;
  /** True when the key was used before, even by a deleted entry. */
  exists(kind: EntryKind, scope: SharedScope, key: string): boolean;
  put(
    kind: EntryKind,
    scope: SharedScope,
    entry: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
    author: EntryAuthor,
  ): void;
  /** False when there was no such entry. */
  delete(
    kind: EntryKind,
    scope: SharedScope,
    key: string,
    author: EntryAuthor,
  ): boolean;
  /** The explicit folders; folders that only hold files are not listed. */
  listFolders(scope: SharedScope): string[];
  createFolder(scope: SharedScope, path: string): void;
  /** Moves the folder, its explicit subfolders and the files inside it. */
  renameFolder(
    scope: SharedScope,
    from: string,
    to: string,
    author: EntryAuthor,
  ): void;
  /** Deletes the folder, its explicit subfolders and the files inside it. */
  deleteFolder(scope: SharedScope, path: string, author: EntryAuthor): void;
}

/** Thrown for a bad key, an unavailable scope or an invalid value. */
export class EntryError extends Error {
  override name = "EntryError";
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
    throw new EntryError(`Invalid file name "${path}": ${problem}.`);
  }
}

/** A value tagged JSON must parse (decision 5). */
export function checkFileValue(mediaType: MediaType, value: string): void {
  if (mediaType !== "application/json") return;
  try {
    JSON.parse(value);
  } catch (err) {
    throw new EntryError(
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

export interface NoteEntry {
  scope: Scope;
  id: string;
  text: string;
}

/** A search over one kind of entry in some scopes (decisions 22 to 30). */
export interface SearchQuery {
  kind: EntryKind;
  query: string;
  scopes: readonly Scope[];
  /** Most hits to return; left out: every match. */
  limit?: number | undefined;
  signal?: AbortSignal;
}

export interface SearchHit {
  scope: Scope;
  /** The file key, or the note id. */
  key: string;
  /** The matching chunk; for a note, its whole text. */
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

/** Searches files or notes; implemented by the backend for one session. */
export type EntrySearch = (query: SearchQuery) => Promise<SearchResult>;

/**
 * One scope, several, or (left out) every scope this session has. Several
 * are listed in the usual order (session, project, global), once each.
 */
export type ScopeFilter = Scope | readonly Scope[];

/** What tools use to reach files and notes (`ToolContext.entries`). */
export interface EntryAccess {
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
  listNotes(scope?: ScopeFilter): NoteEntry[];
  /** Returns the new note's id. */
  addNote(scope: Scope, text: string): string;
  updateNote(scope: Scope, id: string, text: string): boolean;
  deleteNote(scope: Scope, id: string): boolean;
  /** Every scope when `scope` is left out. */
  search(
    kind: EntryKind,
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

/** Current session-scoped entries, by kind and key. */
export interface SessionEntries {
  file: Map<string, Current>;
  note: Map<string, Current>;
  /** Explicit folders (D6); folders that only hold files are not here. */
  folders: Set<string>;
  /** Every key ever used, including deleted ones (ids are not reused). */
  used: { file: Set<string>; note: Set<string> };
}

/** The changes a message carries, if any. */
export function messageEntryOps(message: Message): readonly EntryOp[] {
  if (message.role === "edit") return message.entries;
  if (message.role === "tool") return message.entries ?? [];
  return [];
}

export function applyEntryOp(state: SessionEntries, op: EntryOp): void {
  if (op.op === "folder") {
    if (op.action === "create") state.folders.add(op.path);
    else state.folders.delete(op.path);
    return;
  }
  state.used[op.kind].add(op.key);
  if (op.op === "put") {
    state[op.kind].set(op.key, {
      value: op.value,
      ...(op.mediaType ? { mediaType: op.mediaType } : {}),
      ...(op.blob ? { blob: op.blob } : {}),
    });
  } else {
    state[op.kind].delete(op.key);
  }
}

/** Rebuilds session-scoped files and notes from the transcript. */
export function replaySessionEntries(
  messages: readonly Message[],
): SessionEntries {
  const state: SessionEntries = {
    file: new Map(),
    note: new Map(),
    folders: new Set(),
    used: { file: new Set(), note: new Set() },
  };
  for (const m of messages) {
    for (const op of messageEntryOps(m)) applyEntryOp(state, op);
  }
  return state;
}

/** One version of a session-scoped entry, read from the transcript. */
export interface SessionEntryVersion {
  /** The message that made the change. */
  messageId: string;
  /** "user" for an edit message, "model" for a tool result. */
  by: "user" | "model";
  op: Exclude<EntryOp, { op: "folder" }>;
}

/** Every change to one session-scoped entry, oldest first. */
export function sessionEntryVersions(
  messages: readonly { id: string; message: Message }[],
  kind: EntryKind,
  key: string,
): SessionEntryVersion[] {
  const out: SessionEntryVersion[] = [];
  for (const { id, message } of messages) {
    for (const op of messageEntryOps(message)) {
      if (op.op !== "folder" && op.kind === kind && op.key === key) {
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

const randomNoteId = (): string => {
  // 16 hex digits, so an id is effectively never in two scopes (tool
  // prompts D18).
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface EntryAccessOptions {
  /** Session-scoped entries; changed in place by writes. */
  session: SessionEntries;
  /** Session-scoped changes are appended here, to be recorded. */
  sessionOps: EntryOp[];
  /** Project and global entries. Left out: only session scope exists. */
  shared?: SharedEntries;
  inProject: boolean;
  author: EntryAuthor;
  /** Generates note ids. Default: 16 random hex digits. */
  newNoteId?: () => string;
  /** Search. Left out: searching fails with an EntryError. */
  search?: EntrySearch;
}

/** The `EntryAccess` a tool gets for one call. */
export function createEntryAccess(options: EntryAccessOptions): EntryAccess {
  const { session, sessionOps, shared, author } = options;
  const newNoteId = options.newNoteId ?? randomNoteId;
  const scopes: Scope[] = ["session"];
  if (shared && options.inProject) scopes.push("project");
  if (shared) scopes.push("global");

  const requireScope = (scope: Scope) => {
    if (scopes.includes(scope)) return;
    throw new EntryError(
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
  const sessionOp = (op: EntryOp) => {
    applyEntryOp(session, op);
    sessionOps.push(op);
  };
  const get = (kind: EntryKind, scope: Scope, key: string) =>
    scope === "session"
      ? session[kind].get(key)
      : shared?.get(kind, scope, key);
  const put = (
    kind: EntryKind,
    scope: Scope,
    entry: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
  ) => {
    if (scope === "session") sessionOp({ op: "put", kind, ...entry });
    else shared?.put(kind, scope, entry, author);
  };
  const remove = (kind: EntryKind, scope: Scope, key: string): boolean => {
    if (scope !== "session")
      return shared?.delete(kind, scope, key, author) ?? false;
    if (!session[kind].has(key)) return false;
    sessionOp({ op: "delete", kind, key });
    return true;
  };
  const fileKeys = (scope: Scope): string[] =>
    list("file", scope).map((e) => e.key);
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
        ...fileKeys(scope).flatMap(parentFolders),
      ]),
    ].sort();
  };
  /** True when the file is new; refuses a name that is a folder (D6). */
  const checkNewFile = (scope: Scope, key: string): boolean => {
    const existing = get("file", scope, key);
    if (existing === undefined) {
      if (allFolders(scope).includes(key)) {
        throw new EntryError(`"${key}" is a folder, so it cannot be a file.`);
      }
      const blocking = parentFolders(key).find((p) =>
        fileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new EntryError(
          `"${blocking}" is a file, so it cannot also be a folder for "${key}".`,
        );
      }
    }
    return existing === undefined;
  };
  const list = (kind: EntryKind, scope: Scope) =>
    scope === "session"
      ? [...session[kind]].map(([key, c]) => ({ key, ...c }))
      : (shared?.list(kind, scope) ?? []);

  return {
    scopes,
    listFiles: (scope) =>
      listScopes(scope).flatMap((s) =>
        list("file", s).map((e) => ({
          scope: s,
          key: e.key,
          mediaType: e.mediaType ?? "text/plain",
          size: e.blob?.size ?? e.value.length,
        })),
      ),
    readFile: (scope, key) => {
      requireScope(scope);
      checkFileName(key);
      const e = get("file", scope, key);
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
        throw new EntryError(
          `${mediaType} is a binary type. Binary files are added by upload, not written as text.`,
        );
      }
      checkFileValue(mediaType, value);
      const isNew = checkNewFile(scope, key);
      put("file", scope, { key, value, mediaType });
      return isNew;
    },
    putBlob: (scope, key, mediaType, blob) => {
      requireScope(scope);
      checkFileName(key);
      if (!isBinaryMediaType(mediaType)) {
        throw new EntryError(`${mediaType} is not a binary type.`);
      }
      const isNew = checkNewFile(scope, key);
      put("file", scope, { key, value: "", mediaType, blob });
      return isNew;
    },
    deleteFile: (scope, key) => {
      requireScope(scope);
      checkFileName(key);
      return remove("file", scope, key);
    },
    listFolders: (scope) =>
      listScopes(scope).flatMap((s) =>
        allFolders(s).map((path) => ({ scope: s, path })),
      ),
    createFolder: (scope, path) => {
      requireScope(scope);
      checkFileName(path);
      if (fileKeys(scope).includes(path)) {
        throw new EntryError(`"${path}" is a file, so it cannot be a folder.`);
      }
      const blocking = parentFolders(path).find((p) =>
        fileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new EntryError(
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
        throw new EntryError(`A folder cannot be moved into itself.`);
      }
      if (allFolders(scope).includes(to) || fileKeys(scope).includes(to)) {
        throw new EntryError(`"${to}" already exists.`);
      }
      const blocking = parentFolders(to).find((p) =>
        fileKeys(scope).includes(p),
      );
      if (blocking !== undefined) {
        throw new EntryError(
          `"${blocking}" is a file, so it cannot also be a folder for "${to}".`,
        );
      }
      const moved = fileKeys(scope).filter((k) => isInFolder(k, from));
      const rename = (path: string) => `${to}${path.slice(from.length)}`;
      if (scope !== "session") {
        shared?.renameFolder(scope, from, to, author);
        return { files: moved.length };
      }
      for (const key of moved) {
        const e = session.file.get(key);
        if (!e) continue;
        sessionOp({
          op: "put",
          kind: "file",
          key: rename(key),
          value: e.value,
          ...(e.mediaType ? { mediaType: e.mediaType } : {}),
          ...(e.blob ? { blob: e.blob } : {}),
        });
        sessionOp({ op: "delete", kind: "file", key });
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
      const gone = fileKeys(scope).filter((k) => isInFolder(k, path));
      if (scope !== "session") {
        shared?.deleteFolder(scope, path, author);
        return { files: gone.length };
      }
      for (const key of gone) {
        sessionOp({ op: "delete", kind: "file", key });
      }
      for (const f of [...session.folders].filter((f) => isInFolder(f, path))) {
        sessionOp({ op: "folder", action: "delete", path: f });
      }
      return { files: gone.length };
    },
    listNotes: (scope) =>
      listScopes(scope).flatMap((s) =>
        list("note", s).map((e) => ({ scope: s, id: e.key, text: e.value })),
      ),
    addNote: (scope, text) => {
      requireScope(scope);
      const used = (id: string) =>
        scope === "session"
          ? session.used.note.has(id)
          : (shared?.exists("note", scope, id) ?? false);
      let id = newNoteId();
      for (let i = 0; used(id); i++) {
        if (i >= 100) throw new EntryError("Could not generate a note id.");
        id = newNoteId();
      }
      put("note", scope, { key: id, value: text });
      return id;
    },
    updateNote: (scope, id, text) => {
      requireScope(scope);
      if (get("note", scope, id) === undefined) return false;
      put("note", scope, { key: id, value: text });
      return true;
    },
    deleteNote: (scope, id) => {
      requireScope(scope);
      return remove("note", scope, id);
    },
    search: async (kind, query, scope, limit) => {
      const scopesToSearch = listScopes(scope);
      if (!options.search) throw new EntryError("Search is not available.");
      return options.search({ kind, query, scopes: scopesToSearch, limit });
    },
  };
}

/** The notice the model reads for an edit message (plan P4). */
export function editNotice(ops: readonly EntryOp[]): string {
  const parts = ops.map((op) => {
    if (op.op === "folder") {
      return `${op.action === "create" ? "created" : "deleted"} session folder ${op.path}`;
    }
    const what =
      op.kind === "file" ? `file ${op.key}` : `memory note ${op.key}`;
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
