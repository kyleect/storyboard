import type { Database } from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { editNotice, fileNameProblem, type FileOp } from "@harness/core";
import { sha256 } from "./blobs.js";

/*
 * Data steps (files unification design, Q9): changes to stored data that a
 * SQL migration cannot make, such as JSON inside `messages.message`. Each
 * step runs once, in its own transaction, after the migrations; the table
 * `data_steps` records which have run, so a second start changes nothing.
 * Nothing reads the old shapes afterwards.
 */

export interface DataStep {
  /** Never changes once released: it is what records the step as done. */
  name: string;
  /** Makes the change. Returns how many rows it changed. */
  run(db: Database): number;
}

type Json = Record<string, unknown>;

/*
 * The steps before `files-rename` work on the stored shape of their time:
 * a message's file changes are in `entries`, and each change has a `kind`.
 * They do not use the types of `@harness/core`, which describe the shape
 * after `files-rename`.
 */
type OldFileOp = Json & { op: string; kind?: string; key?: string };

/** The change without its `kind`. */
function withoutKind(op: Json): Json {
  return Object.fromEntries(Object.entries(op).filter(([k]) => k !== "kind"));
}

/** Every key of a file ever used by the messages' changes, deleted or not. */
function oldUsedFileKeys(messages: Json[]): Set<string> {
  const used = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m["entries"])) continue;
    for (const op of m["entries"] as OldFileOp[]) {
      if (op.kind === "file" && typeof op.key === "string") used.add(op.key);
    }
  }
  return used;
}

/** The edit notice of old-shape changes (it names a change by `op` and `key`). */
function oldEditNotice(ops: OldFileOp[]): string {
  return editNotice(ops.map(withoutKind) as unknown as FileOp[]);
}

/** Rewrites every message with `rewrite`; it returns true when it changed one. */
export function rewriteMessages(
  db: Database,
  rewrite: (message: Json) => boolean,
): number {
  const rows = db.prepare("SELECT id, message FROM messages").all() as {
    id: string;
    message: string;
  }[];
  const update = db.prepare("UPDATE messages SET message = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const message = JSON.parse(row.message) as Json;
    if (!rewrite(message)) continue;
    update.run(JSON.stringify(message), row.id);
    changed++;
  }
  return changed;
}

const MEDIA_TYPES: Record<string, string> = {
  plain: "text/plain",
  markdown: "text/markdown",
  json: "application/json",
};

/** A file operation's `type` becomes `mediaType` (D3). */
export function fileOpsToMediaTypes(message: Json): boolean {
  const ops = message["entries"];
  if (!Array.isArray(ops)) return false;
  let changed = false;
  for (const op of ops as Json[]) {
    if (op["op"] !== "put" || !("type" in op)) continue;
    const old = op["type"];
    delete op["type"];
    if (typeof old === "string" && MEDIA_TYPES[old]) {
      op["mediaType"] = MEDIA_TYPES[old];
    }
    changed = true;
  }
  return changed;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};

interface OldAttachment {
  id: string;
  kind?: string;
  mediaType?: string;
  name?: string;
  size?: number;
}

/**
 * A file name for an old attachment: its own name when that follows the
 * rules, otherwise `attachment.<ext>`; a suffix when the name is taken
 * (D8, D13).
 */
export function attachmentFileName(
  name: string | undefined | null,
  mediaType: string,
  taken: ReadonlySet<string>,
): string {
  const ext = EXTENSIONS[mediaType] ?? "bin";
  // Only the last segment, without control characters or a trailing dot or
  // space, in case an old name had them.
  const cleaned = ((name ?? "").split(/[\\/]/).at(-1) ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[. ]+$/, "");
  const wanted =
    cleaned !== "" && fileNameProblem(cleaned) === undefined
      ? cleaned
      : `attachment.${ext}`;
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.indexOf(".", 1);
  const stem = dot === -1 ? wanted : wanted.slice(0, dot);
  const tail = dot === -1 ? "" : wanted.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Moves the files users attached to messages (table `attachments`, 0024) into
 * session files (files unification design, D9, D13). For each user message
 * with attachments, an edit message that adds the files is put before it, the
 * bytes go to `blobs`, and the message lists references (`files`) instead of
 * descriptions. An attachment whose bytes are gone keeps its reference, which
 * the model is told is no longer available. The table is dropped at the end.
 */
export function attachmentsToFiles(db: Database): number {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'",
    )
    .get();
  if (!table) return 0;

  const sessions = db
    .prepare(
      `SELECT DISTINCT session_id FROM messages
       WHERE instr(message, '"attachments"') > 0`,
    )
    .all() as { session_id: string }[];
  const getRow = db.prepare(
    `SELECT media_type, name, data, created_at FROM attachments
     WHERE id = ? AND session_id = ?`,
  );
  const putBlobRow = db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, media_type, size, data, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const OFFSET = 1_000_000_000;
  let changed = 0;

  for (const { session_id: sessionId } of sessions) {
    const rows = db
      .prepare(
        "SELECT id, seq, message, created_at FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as {
      id: string;
      seq: number;
      message: string;
      created_at: string;
    }[];
    const parsed = rows.map((r) => ({ ...r, json: JSON.parse(r.message) }));
    // Names already used by files of the session, so a new one never reuses
    // one: every key the transcript has used.
    const taken = oldUsedFileKeys(parsed.map((r) => r.json));

    type Out =
      | { kind: "old"; id: string; message: string | null }
      | { kind: "new"; id: string; message: string; created_at: string };
    const out: Out[] = [];
    for (const r of parsed) {
      const old = r.json.attachments as OldAttachment[] | undefined;
      if (r.json.role !== "user" || !Array.isArray(old) || old.length === 0) {
        out.push({ kind: "old", id: r.id, message: null });
        continue;
      }
      const refs: string[] = [];
      const ops: OldFileOp[] = [];
      for (const a of old) {
        const row = getRow.get(a.id, sessionId) as
          | {
              media_type: string;
              name: string | null;
              data: Buffer;
              created_at: string;
            }
          | undefined;
        const mediaType = row?.media_type ?? a.mediaType ?? "image/png";
        const key = attachmentFileName(
          row?.name ?? a.name ?? null,
          mediaType,
          taken,
        );
        taken.add(key);
        refs.push(`session://${key}`);
        if (!row) continue;
        const hash = sha256(row.data);
        putBlobRow.run(
          hash,
          mediaType,
          row.data.length,
          row.data,
          row.created_at,
        );
        ops.push({
          op: "put",
          kind: "file",
          key,
          value: "",
          mediaType,
          blob: { hash, size: row.data.length },
        });
      }
      if (ops.length > 0) {
        const edit = {
          role: "edit",
          content: oldEditNotice(ops),
          entries: ops,
        };
        out.push({
          kind: "new",
          id: randomUUID(),
          message: JSON.stringify(edit),
          created_at: r.created_at,
        });
      }
      delete r.json.attachments;
      r.json.files = refs;
      out.push({ kind: "old", id: r.id, message: JSON.stringify(r.json) });
      changed++;
    }

    // Renumber the session's messages in the new order. First move them out
    // of the way, because (session_id, seq) is unique.
    db.prepare("UPDATE messages SET seq = seq + ? WHERE session_id = ?").run(
      OFFSET,
      sessionId,
    );
    const place = db.prepare(
      "UPDATE messages SET seq = ?, message = coalesce(?, message) WHERE id = ?",
    );
    const insert = db.prepare(
      `INSERT INTO messages (id, session_id, seq, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    out.forEach((o, i) => {
      if (o.kind === "old") place.run(i + 1, o.message, o.id);
      else insert.run(o.id, sessionId, i + 1, o.message, o.created_at);
    });
  }

  db.exec("DROP TABLE attachments");
  return changed;
}

/**
 * Chains every session's messages into one line (message editing and forking
 * plan, part A). Top-level messages, those no subagent run wrote, point at
 * the one before them by `seq`, and the session points at the last. A
 * subagent run's messages get an anchor: the top-level assistant message
 * that holds the root `start_subagent` call, found by parsing the messages
 * of the run that started it. When there is none (a run that crashed before
 * saving it), the anchor is the nearest top-level message before the run's
 * first message, so they stay visible as they are today.
 */
export function branchesBackfill(db: Database): number {
  const sessions = db.prepare("SELECT id FROM sessions").all() as {
    id: string;
  }[];
  const setLine = db.prepare(
    "UPDATE messages SET parent_id = ?, last_child_id = ? WHERE id = ?",
  );
  const setAnchor = db.prepare(
    "UPDATE messages SET anchor_id = ? WHERE id = ?",
  );
  const setTip = db.prepare("UPDATE sessions SET tip_id = ? WHERE id = ?");
  let changed = 0;

  for (const { id: sessionId } of sessions) {
    const rows = db
      .prepare(
        "SELECT id, seq, message FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as { id: string; seq: number; message: string }[];
    if (rows.length === 0) continue;

    // Every message a subagent run wrote, with the earliest such run.
    const childRuns = new Map<string, string>();
    for (const r of db
      .prepare(
        `SELECT rm.message_id AS message_id, rm.run_id AS run_id
         FROM run_messages rm JOIN runs r ON r.id = rm.run_id
         WHERE r.session_id = ? AND r.parent_run_id IS NOT NULL
         ORDER BY r.started_at DESC, r.rowid DESC`,
      )
      .all(sessionId) as { message_id: string; run_id: string }[]) {
      // Later rows (earlier runs) overwrite, so the earliest run wins.
      childRuns.set(r.message_id, r.run_id);
    }

    const top = rows.filter((r) => !childRuns.has(r.id));
    top.forEach((r, i) => {
      setLine.run(top[i - 1]?.id ?? null, top[i + 1]?.id ?? null, r.id);
      changed++;
    });
    const last = top.at(-1);
    setTip.run(last?.id ?? null, sessionId);
    if (!last) continue;

    const topIds = new Set(top.map((r) => r.id));
    const bySeq = new Map(rows.map((r) => [r.id, r]));
    const runRow = db.prepare(
      "SELECT parent_run_id, parent_call_id FROM runs WHERE id = ?",
    );
    const runMessages = db.prepare(
      `SELECT m.id AS id, m.message AS message FROM run_messages rm
       JOIN messages m ON m.id = rm.message_id
       WHERE rm.run_id = ? ORDER BY rm.seq`,
    );
    const firstOfRun = db.prepare(
      `SELECT min(m.seq) AS seq FROM run_messages rm
       JOIN messages m ON m.id = rm.message_id WHERE rm.run_id = ?`,
    );

    const holdsCall = (json: string, callId: string): boolean => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return false;
      }
      const m = parsed as { role?: unknown; content?: unknown };
      return (
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as { type?: unknown; callId?: unknown }[]).some(
          (b) => b.type === "tool_call" && b.callId === callId,
        )
      );
    };

    const anchors = new Map<string, string | null>();
    const anchorOfRun = (runId: string, seen = new Set<string>()): string => {
      const known = anchors.get(runId);
      if (known) return known;
      seen.add(runId);
      const run = runRow.get(runId) as
        | { parent_run_id: string | null; parent_call_id: string | null }
        | undefined;
      let found: string | undefined;
      if (run?.parent_run_id && run.parent_call_id) {
        const holder = (
          runMessages.all(run.parent_run_id) as {
            id: string;
            message: string;
          }[]
        ).find((m) => holdsCall(m.message, run.parent_call_id as string));
        if (holder) {
          // A message of a subagent run carries the anchor of that run.
          const holderRun = childRuns.get(holder.id);
          found = topIds.has(holder.id)
            ? holder.id
            : holderRun !== undefined && !seen.has(holderRun)
              ? anchorOfRun(holderRun, seen)
              : undefined;
        }
      }
      if (!found) {
        // The nearest top-level message before the run's first message.
        const first = (firstOfRun.get(runId) as { seq: number | null }).seq;
        const before = top
          .filter((r) => first !== null && r.seq < first)
          .at(-1);
        found = (before ?? top[0] ?? last).id;
      }
      anchors.set(runId, found);
      return found;
    };

    for (const [messageId, runId] of childRuns) {
      if (!bySeq.has(messageId)) continue;
      setAnchor.run(anchorOfRun(runId), messageId);
      changed++;
    }
  }
  return changed;
}

const MEMORY_TOOLS = new Set([
  "memory_list",
  "memory_add",
  "memory_update",
  "memory_delete",
  "memory_search",
  "memory_copy",
  "memory_move",
]);

/**
 * Takes memory out of stored transcripts (memory removal). In every message:
 * note changes are dropped from the file changes a message carries, and the
 * `memory_*` calls are dropped from assistant messages. Messages that are left
 * with nothing are deleted: the result of a `memory_*` call, an edit message
 * that only changed notes, and an assistant message that held nothing but
 * `memory_*` calls (unless a subagent run is anchored to it).
 *
 * A deleted message is skipped on every line: the messages that pointed at it
 * point at the nearest message before it that stays, and the session's tip and
 * seen tip move the same way. Returns how many messages it changed or deleted.
 */
export function removeMemoryFromHistory(db: Database): number {
  const rows = db.prepare("SELECT id, message FROM messages").all() as {
    id: string;
    message: string;
  }[];
  const update = db.prepare("UPDATE messages SET message = ? WHERE id = ?");
  const gone = new Set<string>();
  /** Assistant messages left with no content, deleted if nothing anchors. */
  const emptied = new Set<string>();
  /** Messages whose JSON was rewritten. */
  const rewritten = new Set<string>();

  for (const row of rows) {
    const message = JSON.parse(row.message) as Json;
    let touched = false;

    if (
      message["role"] === "tool" &&
      MEMORY_TOOLS.has(String(message["name"]))
    ) {
      gone.add(row.id);
      continue;
    }
    if (message["role"] === "assistant" && Array.isArray(message["content"])) {
      const blocks = message["content"] as Json[];
      const kept = blocks.filter(
        (b) =>
          !(b["type"] === "tool_call" && MEMORY_TOOLS.has(String(b["name"]))),
      );
      if (kept.length !== blocks.length) {
        message["content"] = kept;
        touched = true;
        if (kept.length === 0) emptied.add(row.id);
      }
    }
    if (
      (message["role"] === "tool" || message["role"] === "edit") &&
      Array.isArray(message["entries"])
    ) {
      const ops = message["entries"] as Json[];
      const kept = ops.filter((op) => op["kind"] !== "note");
      if (kept.length !== ops.length) {
        if (message["role"] === "edit") {
          // An edit message made only of note changes has nothing left; the
          // data edit messages carry `entries: []` and never get here.
          if (kept.length === 0) {
            gone.add(row.id);
            continue;
          }
          message["entries"] = kept;
          message["content"] = oldEditNotice(kept as OldFileOp[]);
        } else if (kept.length === 0) {
          delete message["entries"];
        } else {
          message["entries"] = kept;
        }
        touched = true;
      }
    }
    if (touched) {
      update.run(JSON.stringify(message), row.id);
      rewritten.add(row.id);
    }
  }

  // An assistant message left empty goes too, unless a subagent run is
  // anchored to it: that one stays, empty, so the run keeps its place.
  const anchored = db.prepare(
    "SELECT 1 FROM messages WHERE anchor_id = ? LIMIT 1",
  );
  for (const id of emptied) if (!anchored.get(id)) gone.add(id);

  if (gone.size === 0) return rewritten.size;

  const parents = new Map<string, string | null>();
  for (const id of gone) {
    const r = db
      .prepare("SELECT parent_id FROM messages WHERE id = ?")
      .get(id) as { parent_id: string | null } | undefined;
    parents.set(id, r?.parent_id ?? null);
  }
  /** The nearest message before `id` on its line that is not deleted. */
  const survivor = (id: string | null): string | null => {
    let at = id;
    while (at !== null && gone.has(at)) at = parents.get(at) ?? null;
    return at;
  };

  const children = db.prepare("SELECT id FROM messages WHERE parent_id = ?");
  const reparent = db.prepare("UPDATE messages SET parent_id = ? WHERE id = ?");
  const clearHint = db.prepare(
    "UPDATE messages SET last_child_id = NULL WHERE last_child_id = ?",
  );
  const moveTip = db.prepare("UPDATE sessions SET tip_id = ? WHERE tip_id = ?");
  const moveSeen = db.prepare(
    "UPDATE sessions SET seen_tip_id = ? WHERE seen_tip_id = ?",
  );
  const dropRunMessages = db.prepare(
    "DELETE FROM run_messages WHERE message_id = ?",
  );
  const dropMessage = db.prepare("DELETE FROM messages WHERE id = ?");

  for (const id of gone) {
    const to = survivor(parents.get(id) ?? null);
    for (const child of children.all(id) as { id: string }[]) {
      if (!gone.has(child.id)) reparent.run(to, child.id);
    }
    clearHint.run(id);
    moveTip.run(to, id);
    moveSeen.run(to, id);
  }
  for (const id of gone) {
    dropRunMessages.run(id);
    dropMessage.run(id);
  }
  return new Set([...rewritten, ...gone]).size;
}

/**
 * The changes a message carries to session-scoped files are stored under
 * `files`, not `entries`, and a change no longer has a `kind` (every one was
 * a file once the memory notes were gone). Edit messages and tool results are
 * the only messages that carry them; a user message's own `files` list is
 * something else and stays.
 */
export function renameEntriesToFiles(db: Database): number {
  return rewriteMessages(db, (message) => {
    const role = message["role"];
    if (role !== "tool" && role !== "edit") return false;
    if (!Array.isArray(message["entries"])) return false;
    message["files"] = (message["entries"] as Json[]).map(withoutKind);
    delete message["entries"];
    return true;
  });
}

/**
 * The comment a user typed on an approval prompt was stored on a tool result
 * as `note`; it is now `decisionComment`. A tool result has no other `note`
 * of its own: what a tool says to the model in a result is inside its
 * `content`.
 */
export function renameNoteToDecisionComment(db: Database): number {
  return rewriteMessages(db, (message) => {
    if (message["role"] !== "tool" || !("note" in message)) return false;
    message["decisionComment"] = message["note"];
    delete message["note"];
    return true;
  });
}

export const DATA_STEPS: DataStep[] = [
  {
    name: "file-ops-media-types",
    run: (db) => rewriteMessages(db, fileOpsToMediaTypes),
  },
  { name: "attachments-to-files", run: attachmentsToFiles },
  { name: "branches-backfill", run: branchesBackfill },
  { name: "memory-removal", run: removeMemoryFromHistory },
  { name: "files-rename", run: renameEntriesToFiles },
  { name: "decision-comment-rename", run: renameNoteToDecisionComment },
];

/** Runs the steps that have not run yet; returns each one's name and count. */
export function runDataSteps(
  db: Database,
  steps: readonly DataStep[] = DATA_STEPS,
  now: () => string = () => new Date().toISOString(),
): { name: string; changed: number }[] {
  const done = new Set(
    (db.prepare("SELECT name FROM data_steps").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const ran: { name: string; changed: number }[] = [];
  for (const step of steps) {
    if (done.has(step.name)) continue;
    db.transaction(() => {
      const changed = step.run(db);
      db.prepare("INSERT INTO data_steps (name, done_at) VALUES (?, ?)").run(
        step.name,
        now(),
      );
      ran.push({ name: step.name, changed });
    })();
  }
  return ran;
}
