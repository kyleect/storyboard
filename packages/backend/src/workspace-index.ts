import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Database } from "better-sqlite3-multiple-ciphers";
import { classify, resolveIn } from "./workspace-fs.js";
import type { SearchIndex } from "./search-index.js";
import { isUnder } from "./workspace-ticks.js";
import type { WorkspaceRow, WorkspaceStore } from "./workspaces-store.js";

/*
 * Keeping the search index of workspaces current (files unification design,
 * D31, D45, D53). The ticked parts of a workspace are read as text, split
 * into chunks and indexed like scope files. Three things keep it current: a
 * rescan when the app starts and when a session starts (it catches changes
 * made while the app was closed), a watcher on the ticked paths, and a rescan
 * when the ticks, the folder or the trash state change.
 *
 * A rescan stats every ticked file and reads only those whose modified time or
 * size is not what `workspace_index_files` recorded, so it is cheap.
 */

/** The most files indexed in one workspace. */
export const MAX_INDEXED_FILES = 5000;

/** The largest text file that is indexed. */
export const MAX_INDEXED_BYTES = 2 * 1024 * 1024;

export interface ScanResult {
  /** Files read and indexed this time. */
  indexed: number;
  /** Files whose chunks were removed. */
  removed: number;
  /** Files already current. */
  unchanged: number;
  /** Files indexed in the workspace now. */
  files: number;
  /** More files were ticked than the limit allows. */
  truncated: boolean;
  /** The folder is not there, so nothing was changed. */
  unavailable: boolean;
}

export interface IndexStatus {
  files: number;
  chunks: number;
  scanning: boolean;
  truncated: boolean;
  unavailable: boolean;
  lastScan: string | null;
}

export interface WorkspaceIndexerOptions {
  store: WorkspaceStore;
  index: SearchIndex;
  now?: () => string;
  /** Wait after a file event before rescanning. Default 300 ms. */
  debounceMs?: number;
  /** Watch folders. Default true. */
  watch?: boolean;
  /** Called when a watcher or a scan fails (for logging). */
  onError?: (err: Error, workspaceId: string) => void;
  maxFiles?: number;
  maxBytes?: number;
}

interface Watching {
  watcher: FSWatcher;
  /** The ticks and folder it watches, to see when they changed. */
  key: string;
}

export class WorkspaceIndexer {
  private readonly db: Database;
  private readonly now: () => string;
  private readonly debounceMs: number;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly watchers = new Map<string, Watching>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<ScanResult>>();
  private readonly again = new Set<string>();
  private readonly last = new Map<
    string,
    { at: string; truncated: boolean; unavailable: boolean }
  >();
  private stopped = false;

  constructor(private readonly options: WorkspaceIndexerOptions) {
    this.db = options.store.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.debounceMs = options.debounceMs ?? 300;
    this.maxFiles = options.maxFiles ?? MAX_INDEXED_FILES;
    this.maxBytes = options.maxBytes ?? MAX_INDEXED_BYTES;
  }

  /**
   * Scans every live workspace with ticks, and watches them. Called once when
   * the backend starts, after the migrations.
   */
  async start(): Promise<void> {
    this.stopped = false;
    for (const w of this.options.store.list()) {
      if (w.ticks.length > 0) await this.refresh(w.id);
    }
  }

  /** Stops the watchers and any waiting rescan. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all(
      [...this.watchers.values()].map((w) => w.watcher.close()),
    );
    this.watchers.clear();
    await Promise.all([...this.running.values()].map((p) => p.catch(() => {})));
  }

  /**
   * Brings one workspace in line with its ticks, folder and trash state:
   * rescans it and moves the watcher. A workspace in the trash, or with no
   * ticks, has no chunks and no watcher.
   */
  async refresh(id: string): Promise<ScanResult | undefined> {
    const w = this.options.store.get(id);
    if (!w || w.deleted || w.ticks.length === 0) {
      await this.unwatch(id);
      this.forget(id);
      return undefined;
    }
    await this.watch(w);
    return this.scan(id);
  }

  /** Rescans workspaces for a session that is starting. */
  async scanAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const w = this.options.store.get(id);
      if (w && !w.deleted && w.ticks.length > 0) await this.scan(id);
    }
  }

  /**
   * Rescans one workspace. A rescan asked for while one runs waits for it and
   * then runs once more, so a change made meanwhile is not missed.
   */
  scan(id: string): Promise<ScanResult> {
    const running = this.running.get(id);
    if (running) {
      this.again.add(id);
      return running;
    }
    const run = (async () => {
      let result = await this.scanNow(id);
      while (this.again.delete(id) && !this.stopped) {
        result = await this.scanNow(id);
      }
      return result;
    })().finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  status(id: string): IndexStatus {
    const files = this.db
      .prepare(
        "SELECT count(*) AS n FROM workspace_index_files WHERE workspace_id = ?",
      )
      .get(id) as { n: number };
    const chunks = this.db
      .prepare(
        "SELECT count(*) AS n FROM chunks WHERE scope = 'workspace' AND owner_id = ?",
      )
      .get(id) as { n: number };
    const last = this.last.get(id);
    return {
      files: files.n,
      chunks: chunks.n,
      scanning: this.running.has(id),
      truncated: last?.truncated ?? false,
      unavailable: last?.unavailable ?? false,
      lastScan: last?.at ?? null,
    };
  }

  /** How many files of a workspace are searchable. */
  fileCount(id: string): number {
    return this.status(id).files;
  }

  // ---- Scanning -----------------------------------------------------------

  /** The files the ticks cover, as paths inside the folder. */
  collect(w: WorkspaceRow): { files: string[]; truncated: boolean } {
    const out = new Set<string>();
    let truncated = false;
    const add = (rel: string) => {
      if (out.size >= this.maxFiles) {
        truncated = true;
        return false;
      }
      out.add(rel);
      return true;
    };
    const walk = (dirAbs: string, dirRel: string): boolean => {
      let names: string[];
      try {
        names = readdirSync(dirAbs).sort();
      } catch {
        return true;
      }
      for (const name of names) {
        const abs = join(dirAbs, name);
        const rel = dirRel === "" ? name : `${dirRel}/${name}`;
        let l;
        try {
          l = lstatSync(abs);
        } catch {
          continue;
        }
        if (l.isSymbolicLink()) {
          // A link to a file is followed if it stays in the folder; a link to
          // a folder is not entered.
          try {
            resolveIn(w.path, rel);
            if (statSync(abs).isFile() && !add(rel)) return false;
          } catch {
            // Leaves the folder, or broken: not indexed.
          }
        } else if (l.isDirectory()) {
          if (!walk(abs, rel)) return false;
        } else if (l.isFile() && !add(rel)) {
          return false;
        }
      }
      return true;
    };
    for (const tick of w.ticks) {
      let abs: string;
      try {
        abs = resolveIn(w.path, tick);
      } catch {
        continue;
      }
      let l;
      try {
        l = lstatSync(abs);
      } catch {
        continue;
      }
      if (l.isDirectory() && !l.isSymbolicLink()) {
        if (!walk(abs, tick)) break;
      } else if (statSync(abs, { throwIfNoEntry: false })?.isFile()) {
        if (!add(tick)) break;
      }
    }
    return { files: [...out].sort(), truncated };
  }

  private scanNow(id: string): ScanResult {
    const w = this.options.store.get(id);
    const empty: ScanResult = {
      indexed: 0,
      removed: 0,
      unchanged: 0,
      files: 0,
      truncated: false,
      unavailable: false,
    };
    if (!w || w.deleted || w.ticks.length === 0) {
      this.forget(id);
      return empty;
    }
    if (!existsSync(w.path)) {
      // A folder that is gone (an unplugged drive) keeps its index.
      this.last.set(id, {
        at: this.now(),
        truncated: false,
        unavailable: true,
      });
      return { ...empty, unavailable: true, files: this.fileCount(id) };
    }
    const { files, truncated } = this.collect(w);
    const known = new Map(
      (
        this.db
          .prepare(
            "SELECT path, mtime_ms, size FROM workspace_index_files WHERE workspace_id = ?",
          )
          .all(id) as { path: string; mtime_ms: number; size: number }[]
      ).map((r) => [r.path, r]),
    );
    const wanted = new Set(files);
    const gone = [...known.keys()].filter((p) => !wanted.has(p));
    if (gone.length > 0) this.removeFiles(id, gone);

    let indexed = 0;
    let unchanged = 0;
    for (const rel of files) {
      let st;
      try {
        st = statSync(join(w.path, rel));
      } catch {
        continue;
      }
      const seen = known.get(rel);
      if (seen && seen.mtime_ms === st.mtimeMs && seen.size === st.size) {
        unchanged++;
        continue;
      }
      if (this.indexFile(w, rel, st.mtimeMs, st.size)) indexed++;
    }
    this.last.set(id, { at: this.now(), truncated, unavailable: false });
    return {
      indexed,
      removed: gone.length,
      unchanged,
      files: this.fileCount(id),
      truncated,
      unavailable: false,
    };
  }

  /** Reads one file and replaces its chunks. False when it is not text. */
  private indexFile(
    w: WorkspaceRow,
    rel: string,
    mtimeMs: number,
    size: number,
  ): boolean {
    let text: string | null = null;
    if (size <= this.maxBytes) {
      try {
        const data = readFileSync(join(w.path, rel));
        const kind = classify(rel, data);
        if (kind.kind === "text") text = data.toString("utf8");
      } catch {
        text = null;
      }
    }
    // A file that is not text, too big or unreadable has no chunks, but is
    // remembered so it is not read again until it changes.
    this.options.index.indexFile("workspace", w.id, rel, text);
    this.db
      .prepare(
        `INSERT INTO workspace_index_files (workspace_id, path, mtime_ms, size)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
      )
      .run(w.id, rel, mtimeMs, size);
    return text !== null;
  }

  private removeFiles(id: string, paths: readonly string[]) {
    this.options.index.dropWorkspaceFiles(id, paths);
    const del = this.db.prepare(
      "DELETE FROM workspace_index_files WHERE workspace_id = ? AND path = ?",
    );
    this.db.transaction(() => {
      for (const p of paths) del.run(id, p);
    })();
  }

  /** Removes everything indexed for a workspace. */
  private forget(id: string) {
    this.options.index.dropWorkspaceFiles(id);
    this.db
      .prepare("DELETE FROM workspace_index_files WHERE workspace_id = ?")
      .run(id);
    this.last.delete(id);
  }

  // ---- Watching -----------------------------------------------------------

  private async unwatch(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    const w = this.watchers.get(id);
    this.watchers.delete(id);
    if (w) await w.watcher.close();
  }

  private async watch(w: WorkspaceRow) {
    if (this.options.watch === false || this.stopped) return;
    const key = JSON.stringify([w.path, w.ticks]);
    const existing = this.watchers.get(w.id);
    if (existing?.key === key) return;
    await this.unwatch(w.id);
    const targets = w.ticks.map((t) => (t === "" ? w.path : join(w.path, t)));
    const watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      followSymlinks: false,
    });
    const poke = (path: string) => {
      if (this.stopped) return;
      // Events under the ticked paths only; a rename shows as unlink + add.
      if (
        !w.ticks.some((t) => isUnder(path, t === "" ? w.path : join(w.path, t)))
      ) {
        return;
      }
      const old = this.timers.get(w.id);
      if (old) clearTimeout(old);
      this.timers.set(
        w.id,
        setTimeout(() => {
          this.timers.delete(w.id);
          this.scan(w.id).catch((err: Error) =>
            this.options.onError?.(err, w.id),
          );
        }, this.debounceMs),
      );
    };
    watcher.on("all", (_event, path) => poke(path));
    watcher.on("error", (err) =>
      this.options.onError?.(
        err instanceof Error ? err : new Error(String(err)),
        w.id,
      ),
    );
    this.watchers.set(w.id, { watcher, key });
    // Wait until it is watching, but not forever on a huge or slow folder.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
      watcher.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
