import type { Database } from "better-sqlite3-multiple-ciphers";
import {
  mediaKindOf,
  replaySessionEntries,
  type ChatRequest,
  type Message,
  type ModelAdapter,
  type ResolvedFile,
} from "@harness/core";
import type { AgentStore } from "./agents-store.js";
import { getBlob } from "./blobs.js";
import type { SearchIndex } from "./search-index.js";
import type { Settings } from "./settings.js";
import { activeMessageJson } from "./transcript.js";

/*
 * Derived text (files unification design, D18, D43, D44, D56 to D60): the
 * description or transcript of an image or audio file, kept with its bytes in
 * `blobs` (migration 0028). The built-in Media Describer agent writes it with
 * one plain request, no tool loop and no handback: its prompt is the system
 * message and the file is the user message. It runs once per upload, one at
 * a time, and a failure is not retried (the Retry button is).
 */

/** The id of the built-in agent, the default of the "Media describer agent" setting. */
export const MEDIA_DESCRIBER = "builtin-media-describer";

/** A generation that takes longer counts as failed (D60). */
export const DESCRIBE_TIMEOUT_MS = 120_000;

/** Only this much of a text is indexed; the rest is kept (D60). */
export const DERIVED_INDEX_CHARS = 4000;

export type DerivedState =
  "none" | "pending" | "generated" | "edited" | "failed";

export interface Derived {
  text: string;
  state: DerivedState;
}

export const DERIVED_TEXT_MAX = 50_000;

export const getDerived = (db: Database, hash: string): Derived | undefined =>
  db
    .prepare(
      "SELECT derived_text AS text, derived_state AS state FROM blobs WHERE hash = ?",
    )
    .get(hash) as Derived | undefined;

export interface MediaDescriberOptions {
  db: Database;
  settings: () => Settings;
  agents: AgentStore;
  model: (settings: Settings) => ModelAdapter;
  /** Kept in step with the text, so a file is found by what it shows. */
  index?: SearchIndex;
  timeoutMs?: number;
  /** Called when a file's text or state changed. */
  onChange?: (hash: string) => void;
}

export class MediaDescriber {
  private queue: Promise<void> = Promise.resolve();
  /** Generations waiting or running, by hash, so one is never queued twice. */
  private readonly active = new Set<string>();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: MediaDescriberOptions) {}

  private get db() {
    return this.options.db;
  }

  /** The agent's prompt, or undefined when generation is off or it is gone. */
  private prompt(): string | undefined {
    const s = this.options.settings();
    if (s.mediaDescriberModel === "" || s.mediaDescriberAgent === "") {
      return undefined;
    }
    const agent = this.options.agents.get(s.mediaDescriberAgent);
    return agent && !agent.deleted ? agent.prompt : undefined;
  }

  /** Whether files are described: a model and an agent are set (D43). */
  enabled(): boolean {
    return this.prompt() !== undefined;
  }

  /** Marks a generation that was running when the backend stopped as failed. */
  recover(): number {
    const hashes = this.db
      .prepare("SELECT hash FROM blobs WHERE derived_state = 'pending'")
      .all() as { hash: string }[];
    for (const { hash } of hashes) this.set(hash, "", "failed");
    return hashes.length;
  }

  /** Stops what is running and what is waiting; their files are marked failed. */
  stop() {
    for (const c of this.controllers) c.abort();
  }

  /**
   * Describes a file in the background unless it already has text. Does
   * nothing when generation is off. Returns whether one was queued.
   */
  describeNew(hash: string): boolean {
    const now = getDerived(this.db, hash);
    if (!now || now.state !== "none" || !this.enabled()) return false;
    return this.enqueue(hash);
  }

  /** Describes a file again, whatever it has (Retry). False when off or busy. */
  retry(hash: string): boolean {
    const now = getDerived(this.db, hash);
    if (!now || !this.enabled() || this.active.has(hash)) return false;
    return this.enqueue(hash);
  }

  /** How many files there are, and how many have no text (D56). */
  counts(): { files: number; empty: number } {
    const row = this.db
      .prepare(
        `SELECT count(*) AS files,
                coalesce(sum(derived_state IN ('none', 'failed')), 0) AS empty
         FROM blobs
         WHERE media_type LIKE 'image/%' OR media_type LIKE 'audio/%'`,
      )
      .get() as { files: number; empty: number };
    return row;
  }

  /**
   * The user's answer to "Generate descriptions for N files?": `empty` fills
   * the files with no text, `all` writes every file again, except text the
   * user edited. Returns how many were queued.
   */
  regenerate(mode: "empty" | "all"): number {
    if (!this.enabled()) return 0;
    const rows = this.db
      .prepare(
        `SELECT hash FROM blobs
         WHERE (media_type LIKE 'image/%' OR media_type LIKE 'audio/%')
           AND derived_state NOT IN ('pending', 'edited')
           AND (? = 'all' OR derived_state IN ('none', 'failed'))`,
      )
      .all(mode) as { hash: string }[];
    let n = 0;
    for (const { hash } of rows) if (this.enqueue(hash)) n++;
    return n;
  }

  /** Sets the text the user wrote. Empty text clears it. */
  setText(hash: string, text: string): boolean {
    if (!getDerived(this.db, hash)) return false;
    this.set(hash, text, text.trim() === "" ? "none" : "edited");
    return true;
  }

  /** Waits for what is queued (for tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(hash: string): boolean {
    if (this.active.has(hash)) return false;
    this.active.add(hash);
    // Marked now so the Files view shows it is on its way.
    this.set(hash, getDerived(this.db, hash)?.text ?? "", "pending");
    this.queue = this.queue
      .then(() => this.run(hash))
      .catch(() => {})
      .finally(() => this.active.delete(hash));
    return true;
  }

  private async run(hash: string): Promise<void> {
    const before = this.db
      .prepare("SELECT derived_text FROM blobs WHERE hash = ?")
      .get(hash) as { derived_text: string } | undefined;
    const prompt = this.prompt();
    const blob = getBlob(this.db, hash);
    const kind = blob && mediaKindOf(blob.mediaType);
    if (!before || !blob || !kind || prompt === undefined) {
      this.set(hash, before?.derived_text ?? "", before ? "failed" : "none");
      return;
    }
    const settings = this.options.settings();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DESCRIBE_TIMEOUT_MS,
    );
    try {
      const ref = `blob://${hash}`;
      const request: ChatRequest = {
        kind: "chat",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "", files: [ref] },
        ],
        resolveFile: (r): ResolvedFile | undefined =>
          r === ref
            ? {
                kind,
                mediaType: blob.mediaType,
                data: blob.data.toString("base64"),
              }
            : undefined,
        model: settings.mediaDescriberModel,
      };
      let text = "";
      for await (const chunk of this.options
        .model(settings)
        .stream(request, controller.signal)) {
        if (chunk.type === "text") text += chunk.text;
      }
      text = text.trim().slice(0, DERIVED_TEXT_MAX);
      if (controller.signal.aborted || text === "") {
        // Keeps what was there, so a failed retry loses nothing.
        this.set(hash, before.derived_text, "failed");
      } else {
        this.set(hash, text, "generated");
      }
    } catch {
      this.set(hash, before.derived_text, "failed");
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private set(hash: string, text: string, state: DerivedState) {
    this.db
      .prepare(
        "UPDATE blobs SET derived_text = ?, derived_state = ? WHERE hash = ?",
      )
      .run(text, state, hash);
    reindexBlob(this.db, this.options.index, hash);
    this.options.onChange?.(hash);
  }
}

/** The text of a binary file that is indexed: the start of its derived text. */
export const indexedText = (derived: Derived | undefined): string | null =>
  derived && derived.text !== ""
    ? derived.text.slice(0, DERIVED_INDEX_CHARS)
    : null;

/**
 * Indexes every file that has these bytes again, after its text changed: the
 * live project and global files, and the session files a transcript names.
 */
export function reindexBlob(
  db: Database,
  index: SearchIndex | undefined,
  hash: string,
) {
  if (!index) return;
  const text = indexedText(getDerived(db, hash));
  const shared = db
    .prepare(
      `SELECT kind, project_id, key FROM entries
       WHERE blob_hash = ? AND deleted_at IS NULL`,
    )
    .all(hash) as {
    kind: "file" | "note";
    project_id: string | null;
    key: string;
  }[];
  for (const e of shared) {
    index.indexEntry(
      e.kind,
      e.project_id === null ? "global" : "project",
      e.project_id,
      e.key,
      text,
    );
  }
  const sessions = db
    .prepare(
      "SELECT DISTINCT session_id FROM messages WHERE instr(message, ?) > 0",
    )
    .all(hash) as { session_id: string }[];
  for (const { session_id: id } of sessions) {
    const state = replaySessionEntries(
      activeMessageJson(db, id).map((m) => JSON.parse(m) as Message),
    );
    for (const [key, file] of state.file) {
      if (file.blob?.hash === hash)
        index.indexEntry("file", "session", id, key, text);
    }
  }
}
