import type { Database } from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import {
  editNotice,
  fileNameProblem,
  replaySessionEntries,
  type EntryOp,
  type Message,
} from "@harness/core";
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
    const taken = new Set(
      replaySessionEntries(parsed.map((r) => r.json as Message)).used.file,
    );

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
      const ops: EntryOp[] = [];
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
          mediaType: mediaType as never,
          blob: { hash, size: row.data.length },
        });
      }
      if (ops.length > 0) {
        const edit: Message = {
          role: "edit",
          content: editNotice(ops),
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

export const DATA_STEPS: DataStep[] = [
  {
    name: "file-ops-media-types",
    run: (db) => rewriteMessages(db, fileOpsToMediaTypes),
  },
  { name: "attachments-to-files", run: attachmentsToFiles },
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
