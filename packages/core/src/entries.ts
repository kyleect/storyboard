import type {
  EntryKind,
  EntryOp,
  FileType,
  Message,
  ModelMessage,
} from "./messages.js";

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
  type?: FileType;
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
    entry: { key: string; value: string; type?: FileType },
    author: EntryAuthor,
  ): void;
  /** False when there was no such entry. */
  delete(
    kind: EntryKind,
    scope: SharedScope,
    key: string,
    author: EntryAuthor,
  ): boolean;
}

/** Thrown for a bad key, an unavailable scope or an invalid value. */
export class EntryError extends Error {
  override name = "EntryError";
}

const FILE_KEY = /^[A-Za-z0-9._-]+$/;

/** Letters, digits, "-", "_" and "."; case-sensitive (decision 6). */
export function checkFileKey(key: string): void {
  if (!FILE_KEY.test(key)) {
    throw new EntryError(
      `Invalid file key "${key}": use only letters, digits, "-", "_" and ".".`,
    );
  }
}

/** A value tagged JSON must parse (decision 5). */
export function checkFileValue(type: FileType, value: string): void {
  if (type !== "json") return;
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
  type: FileType;
  /** Length of the value in characters. */
  size: number;
}

export interface FileEntry extends FileInfo {
  value: string;
}

export interface NoteEntry {
  scope: Scope;
  id: string;
  text: string;
}

/** What tools use to reach files and notes (`ToolContext.entries`). */
export interface EntryAccess {
  /** The scopes this session has: no project scope in a standalone one. */
  readonly scopes: readonly Scope[];
  /** Every scope's files when `scope` is left out (decision 9). */
  listFiles(scope?: Scope): FileInfo[];
  readFile(scope: Scope, key: string): FileEntry | undefined;
  /** Creates or replaces. Returns true when the file is new. */
  writeFile(scope: Scope, key: string, type: FileType, value: string): boolean;
  deleteFile(scope: Scope, key: string): boolean;
  listNotes(scope?: Scope): NoteEntry[];
  /** Returns the new note's id. */
  addNote(scope: Scope, text: string): string;
  updateNote(scope: Scope, id: string, text: string): boolean;
  deleteNote(scope: Scope, id: string): boolean;
}

interface Current {
  value: string;
  type?: FileType;
}

/** Current session-scoped entries, by kind and key. */
export interface SessionEntries {
  file: Map<string, Current>;
  note: Map<string, Current>;
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
  state.used[op.kind].add(op.key);
  if (op.op === "put") {
    state[op.kind].set(op.key, {
      value: op.value,
      ...(op.type ? { type: op.type } : {}),
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
  op: EntryOp;
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
      if (op.kind === kind && op.key === key) {
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
  const bytes = new Uint8Array(4);
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
  /** Generates note ids. Default: 8 random hex digits. */
  newNoteId?: () => string;
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
  const listScopes = (scope?: Scope): Scope[] => {
    if (scope === undefined) return scopes;
    requireScope(scope);
    return [scope];
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
    entry: { key: string; value: string; type?: FileType },
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
          type: e.type ?? "plain",
          size: e.value.length,
        })),
      ),
    readFile: (scope, key) => {
      requireScope(scope);
      checkFileKey(key);
      const e = get("file", scope, key);
      return e
        ? {
            scope,
            key,
            type: e.type ?? "plain",
            size: e.value.length,
            value: e.value,
          }
        : undefined;
    },
    writeFile: (scope, key, type, value) => {
      requireScope(scope);
      checkFileKey(key);
      checkFileValue(type, value);
      const created = get("file", scope, key) === undefined;
      put("file", scope, { key, value, type });
      return created;
    },
    deleteFile: (scope, key) => {
      requireScope(scope);
      checkFileKey(key);
      return remove("file", scope, key);
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
  };
}

/** The notice the model reads for an edit message (plan P4). */
export function editNotice(ops: readonly EntryOp[]): string {
  const parts = ops.map((op) => {
    const what =
      op.kind === "file" ? `file ${op.key}` : `memory note ${op.key}`;
    return op.op === "put"
      ? `changed session ${what}`
      : `deleted session ${what}`;
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
  let run: { texts: string[]; hasEdit: boolean } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.hasEdit) {
      out.push({ role: "user", content: run.texts.join("\n\n") });
    } else {
      for (const content of run.texts) out.push({ role: "user", content });
    }
    run = null;
  };
  for (const m of messages) {
    if (m.role === "user" || m.role === "edit") {
      run ??= { texts: [], hasEdit: false };
      run.texts.push(m.content);
      if (m.role === "edit") run.hasEdit = true;
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}
