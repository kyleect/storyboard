import type { Database } from "better-sqlite3-multiple-ciphers";
import type { Store } from "./store.js";
import { activeProfile } from "./profiles.js";

/*
 * Forking a session (message editing plan, part D): a new session that holds
 * a copy of the line up to a message, and of the branches that leave that
 * line before it, so the copy shows "2/3" where the original does. Nothing
 * after the message is copied, nor deleted branches, errors or blobs (blobs
 * are shared by hash). The copy is made in one transaction by the caller.
 */

type Row = Record<string, unknown>;

/** The fields of an event's data that name stored rows, and how to map them. */
export const MESSAGE_ID_KEYS = ["messageId"] as const;
export const RUN_ID_KEYS = ["parentRunId"] as const;

export interface ForkInput {
  sourceId: string;
  /** The last message copied; a complete point on the line shown. */
  messageId: string;
  newSessionId: string;
  title: string;
  now: string;
  newId: () => string;
}

export interface ForkResult {
  messages: number;
  runs: number;
}

const ids = (list: Iterable<string>) => JSON.stringify([...list]);

/** The ids of the top-level messages to copy: the line and earlier branches. */
function copiedTopLevel(store: Store, sourceId: string, messageId: string) {
  const path = store.lineIds(messageId);
  const onPath = new Set(path);
  const copied = new Set<string>(path);
  const addSubtree = (root: string) => {
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || copied.has(id)) continue;
      copied.add(id);
      stack.push(...store.children(id));
    }
  };
  // Branches that leave the line before the message, and other first messages.
  const firsts = store.db
    .prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND parent_id IS NULL AND anchor_id IS NULL
         AND trashed_at IS NULL`,
    )
    .all(sourceId) as { id: string }[];
  for (const { id } of firsts) if (!onPath.has(id)) addSubtree(id);
  for (const id of path) {
    if (id === messageId) continue;
    for (const child of store.children(id)) {
      if (!onPath.has(child)) addSubtree(child);
    }
  }
  return { path, copied };
}

function rewriteEvent(
  data: unknown,
  messages: Map<string, string>,
  runs: Map<string, string>,
): { data: unknown } | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { data };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // A run that was not copied is no longer a parent.
    if (
      (RUN_ID_KEYS as readonly string[]).includes(key) &&
      typeof value === "string" &&
      !runs.has(value)
    ) {
      continue;
    }
    out[key] = value;
  }
  for (const key of MESSAGE_ID_KEYS) {
    const value = out[key];
    if (typeof value !== "string") continue;
    const mapped = messages.get(value);
    // The message is after the fork point: so is the event.
    if (mapped === undefined) return null;
    out[key] = mapped;
  }
  for (const key of RUN_ID_KEYS) {
    const value = out[key];
    if (typeof value !== "string") continue;
    const mapped = runs.get(value);
    if (mapped !== undefined) out[key] = mapped;
  }
  return { data: out };
}

function insertRow(db: Database, table: string, row: Row) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys
      .map(() => "?")
      .join(", ")})`,
  ).run(...keys.map((k) => row[k]));
}

/**
 * Copies the session up to `messageId` into a new session. Run it inside a
 * transaction. The caller checks that the source is idle and the message is
 * a complete point on its line.
 */
export function forkSession(store: Store, input: ForkInput): ForkResult {
  const { db } = store;
  const { sourceId, messageId, newSessionId, now, newId } = input;
  const source = store.getSession(sourceId);
  if (!source) throw new Error("Session not found.");

  const { path, copied } = copiedTopLevel(store, sourceId, messageId);

  // Subagent messages ride along with the message they are anchored to.
  const anchored = db
    .prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND anchor_id IN (SELECT value FROM json_each(?))`,
    )
    .all(sourceId, ids(copied)) as { id: string }[];
  const all = new Set<string>([...copied, ...anchored.map((r) => r.id)]);

  const messageRows = db
    .prepare(
      `SELECT * FROM messages
       WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
    )
    .all(ids(all)) as Row[];
  const messageMap = new Map<string, string>();
  for (const row of messageRows) messageMap.set(String(row.id), newId());

  db.prepare(
    `INSERT INTO sessions
       (id, profile_id, title, created_at, project_id, model, reasoning_effort, agent_id,
        forked_from_id, forked_from_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    // The source was found through the store, so it is in the active profile
    // and the fork stays there (profiles design, decision 11).
    activeProfile(db),
    input.title,
    now,
    source.project_id,
    source.model,
    source.reasoning_effort,
    source.agent_id,
    source.id,
    source.title,
  );

  // Where the line goes next, so a branch switched to later carries on.
  const next = new Map<string, string>();
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i];
    const to = path[i + 1];
    if (from !== undefined && to !== undefined) next.set(from, to);
  }

  // Rows go in without their pointers, which are set once all exist.
  const pointers: {
    id: string;
    parent: unknown;
    anchor: unknown;
    last: unknown;
  }[] = [];
  messageRows.forEach((row, index) => {
    const oldId = String(row.id);
    const newMessageId = messageMap.get(oldId) ?? "";
    insertRow(db, "messages", {
      ...row,
      id: newMessageId,
      session_id: newSessionId,
      seq: index + 1,
      parent_id: null,
      anchor_id: null,
      last_child_id: null,
      trashed_at: null,
    });
    const last = next.has(oldId)
      ? next.get(oldId)
      : typeof row.last_child_id === "string"
        ? row.last_child_id
        : undefined;
    pointers.push({
      id: newMessageId,
      parent: row.parent_id,
      anchor: row.anchor_id,
      last: oldId === messageId ? undefined : last,
    });
  });
  const setPointers = db.prepare(
    "UPDATE messages SET parent_id = ?, anchor_id = ?, last_child_id = ? WHERE id = ?",
  );
  for (const p of pointers) {
    const map = (v: unknown) =>
      typeof v === "string" ? (messageMap.get(v) ?? null) : null;
    setPointers.run(map(p.parent), map(p.anchor), map(p.last), p.id);
  }
  const tip = messageMap.get(messageId);
  if (tip === undefined) throw new Error("The message is not on the line.");
  db.prepare("UPDATE sessions SET tip_id = ? WHERE id = ?").run(
    tip,
    newSessionId,
  );

  // Runs that wrote any copied message, with the rows they wrote.
  const runRows = db
    .prepare(
      `SELECT * FROM runs
       WHERE session_id = ? AND id IN (
         SELECT run_id FROM run_messages
         WHERE message_id IN (SELECT value FROM json_each(?)))
       ORDER BY started_at, rowid`,
    )
    .all(sourceId, ids(all)) as Row[];
  const runMap = new Map<string, string>();
  for (const row of runRows) runMap.set(String(row.id), newId());
  for (const row of runRows) {
    insertRow(db, "runs", {
      ...row,
      id: runMap.get(String(row.id)),
      session_id: newSessionId,
      parent_run_id: null,
    });
  }
  const setParent = db.prepare(
    "UPDATE runs SET parent_run_id = ? WHERE id = ?",
  );
  for (const row of runRows) {
    const parent = row.parent_run_id;
    if (typeof parent !== "string") continue;
    setParent.run(runMap.get(parent) ?? null, runMap.get(String(row.id)));
  }
  const runMessages = db
    .prepare(
      `SELECT * FROM run_messages
       WHERE run_id IN (SELECT value FROM json_each(?))
         AND message_id IN (SELECT value FROM json_each(?))
       ORDER BY run_id, seq`,
    )
    .all(ids(runMap.keys()), ids(all)) as Row[];
  for (const row of runMessages) {
    insertRow(db, "run_messages", {
      ...row,
      run_id: runMap.get(String(row.run_id)),
      message_id: messageMap.get(String(row.message_id)),
    });
  }

  // The events of those runs, about the rows that were copied.
  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE session_id = ? AND run_id IN (SELECT value FROM json_each(?))
       ORDER BY id`,
    )
    .all(sourceId, ids(runMap.keys())) as Row[];
  for (const row of events) {
    const rewritten = rewriteEvent(
      JSON.parse(String(row.data)) as unknown,
      messageMap,
      runMap,
    );
    if (!rewritten) continue;
    const stored: Row = { ...row };
    delete stored.id;
    insertRow(db, "events", {
      ...stored,
      run_id: runMap.get(String(row.run_id)),
      session_id: newSessionId,
      data: JSON.stringify(rewritten.data),
    });
  }

  // What the user chose for this session.
  db.prepare(
    `INSERT INTO media_choices (session_id, ref, keep, updated_at)
     SELECT ?, ref, keep, updated_at FROM media_choices WHERE session_id = ?`,
  ).run(newSessionId, sourceId);
  db.prepare(
    `INSERT INTO session_tool_approvals (session_id, tool_name, created_at)
     SELECT ?, tool_name, created_at FROM session_tool_approvals WHERE session_id = ?`,
  ).run(newSessionId, sourceId);
  db.prepare(
    `INSERT INTO session_subject_approvals
       (session_id, tool_name, subject_kind, subject_id, created_at)
     SELECT ?, tool_name, subject_kind, subject_id, created_at
     FROM session_subject_approvals WHERE session_id = ?`,
  ).run(newSessionId, sourceId);
  db.prepare(
    `INSERT INTO workspace_attachments
       (workspace_id, owner_kind, owner_id, read_only, created_at)
     SELECT workspace_id, owner_kind, ?, read_only, created_at
     FROM workspace_attachments WHERE owner_kind = 'session' AND owner_id = ?`,
  ).run(newSessionId, sourceId);

  return { messages: messageRows.length, runs: runRows.length };
}
