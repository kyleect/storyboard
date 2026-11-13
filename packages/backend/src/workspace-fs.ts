import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  fileNameProblem,
  parseRef,
  WorkspaceError,
  type WorkspaceAccess,
  type WorkspaceEntry,
  type WorkspaceInfo,
  type WorkspaceOptions,
  type WorkspaceRead,
} from "@harness/core";
import { detectMedia, MAX_UPLOAD_BYTES } from "./media-detect.js";
import type { AttachedWorkspace } from "./workspaces-store.js";

/*
 * The disk work of workspaces (files unification design, D28 to D32, D47,
 * D48). Every path goes through `resolveIn`, which refuses what leaves the
 * workspace folder, by `..` or by a symlink, unless the user said this one
 * path is fine.
 */

/** The most entries one listing returns. */
export const LIST_LIMIT = 2000;

/** The largest text file that is read (the part returned is cut by the cap). */
const MAX_TEXT_BYTES = 50 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".txt": "text/plain",
};

const typeByName = (name: string): string | undefined =>
  EXTENSION_TYPES[extname(name).toLowerCase()];

const within = (root: string, abs: string): boolean =>
  abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The absolute path for `rel` in the workspace folder `root`. Throws
 * `WorkspaceError("outside")` when it leaves the folder, lexically or through
 * a symlink, unless `allowOutside`.
 */
export function resolveIn(
  root: string,
  rel: string,
  allowOutside = false,
): string {
  if (rel.includes("\0")) {
    throw new WorkspaceError(
      "invalid",
      "A path cannot contain a null character.",
    );
  }
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new WorkspaceError(
      "invalid",
      "Give the path inside the workspace, such as notes/ideas.md, not a full path.",
    );
  }
  const abs = resolve(root, rel);
  const outside = (target: string) =>
    new WorkspaceError(
      "outside",
      `${rel === "" ? "The workspace root" : `"${rel}"`} is outside the workspace folder.`,
      target,
    );
  if (!within(root, abs)) {
    if (allowOutside) return abs;
    throw outside(abs);
  }
  // A symlink inside the folder can lead out: check where the deepest part
  // that exists really is.
  const rootReal = realpathSync(root);
  let probe = abs;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  if (!within(rootReal, real)) {
    if (allowOutside) return abs;
    throw outside(real);
  }
  return abs;
}

const iso = (s: Stats) => s.mtime.toISOString();

function fileOf(
  path: string,
  name: string,
  abs: string,
): WorkspaceEntry | undefined {
  let s: Stats;
  try {
    s = statSync(abs);
  } catch {
    return undefined; // a broken link
  }
  if (s.isDirectory()) return { path, kind: "folder", modifiedAt: iso(s) };
  const mediaType = typeByName(name);
  return {
    path,
    kind: "file",
    size: s.size,
    modifiedAt: iso(s),
    ...(mediaType ? { mediaType } : {}),
  };
}

/** What a file's bytes are: media, text or something else. */
export function classify(
  name: string,
  data: Buffer,
):
  | { kind: "media"; mediaType: string }
  | { kind: "text"; mediaType: string }
  | { kind: "binary" } {
  const declared = typeByName(name);
  if (declared) {
    const found = detectMedia(declared, data);
    if (found) return { kind: "media", mediaType: found.mediaType };
  }
  const head = data.subarray(0, 8000);
  if (head.includes(0)) return { kind: "binary" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { kind: "binary" };
  }
  const type = declared && declared.startsWith("text/") ? declared : undefined;
  return {
    kind: "text",
    mediaType:
      type ?? (declared === "application/json" ? declared : "text/plain"),
  };
}

export interface ReadRecord {
  mtimeMs: number;
  size: number;
}

export interface WorkspaceFsOptions {
  /** The workspaces the session can use now. */
  attached: () => AttachedWorkspace[];
  /** The most characters one read returns. */
  readCap: () => number;
  /**
   * What the agent has read, by `<id>/<path>`: a write or edit is refused when
   * the file changed since, or was not read (D32). Kept across the runs of a
   * session.
   */
  reads: Map<string, ReadRecord>;
  /**
   * The search index of workspaces. Left out: `search` finds nothing and
   * says so.
   */
  index?: {
    search(q: {
      query: string;
      limit: number;
      workspaceIds: readonly string[];
      signal?: AbortSignal;
    }): Promise<{
      hits: {
        workspaceId: string;
        path: string;
        excerpt: string;
        matched: "keyword" | "meaning" | "both";
      }[];
      mode: "keyword+meaning" | "keyword";
      notice?: string;
    }>;
    /** How many files of a workspace are searchable. */
    files(id: string): number;
  };
}

const info = (w: AttachedWorkspace): WorkspaceInfo => ({
  id: w.id,
  name: w.name,
  writable: w.effectiveWritable,
});

export function createWorkspaceAccess(
  options: WorkspaceFsOptions,
): WorkspaceAccess {
  const find = (id: string): AttachedWorkspace => {
    const w = options.attached().find((x) => x.id === id);
    if (!w) {
      throw new WorkspaceError(
        "not_found",
        `No workspace with the id ${id} is attached to this session. Call workspaces_list.`,
      );
    }
    if (!existsSync(w.path)) {
      throw new WorkspaceError(
        "unavailable",
        `The folder of the workspace "${w.name}" is not there any more (${w.path}).`,
      );
    }
    return w;
  };
  const writable = (w: AttachedWorkspace) => {
    if (!w.effectiveWritable) {
      throw new WorkspaceError(
        "read_only",
        `The workspace "${w.name}" is read-only here.`,
      );
    }
  };
  const key = (id: string, path: string) => `${id}/${path}`;
  const record = (id: string, path: string, s: Stats) =>
    options.reads.set(key(id, path), { mtimeMs: s.mtimeMs, size: s.size });
  /** A file that exists must have been read, and not changed since (D32). */
  const checkFresh = (id: string, path: string, abs: string) => {
    const s = statSync(abs);
    const seen = options.reads.get(key(id, path));
    if (!seen) {
      throw new WorkspaceError(
        "stale",
        `"${path}" exists and has not been read in this session. Read it with workspace_read first.`,
      );
    }
    if (seen.mtimeMs !== s.mtimeMs || seen.size !== s.size) {
      throw new WorkspaceError(
        "stale",
        `"${path}" changed on disk since it was read. Read it again with workspace_read, then retry.`,
      );
    }
  };
  // A path the user approved outside the folder may have `..` in it; the
  // name of what is created is still checked.
  const newName = (path: string, o?: WorkspaceOptions) => {
    const checked = opts(o) ? (path.split("/").at(-1) ?? path) : path;
    const problem = fileNameProblem(checked);
    if (problem) {
      throw new WorkspaceError(
        "invalid",
        `"${path}" cannot be used: ${problem}.`,
      );
    }
  };
  const opts = (o?: WorkspaceOptions) => o?.allowOutside === true;

  return {
    list: () => options.attached().map(info),
    get readCap() {
      return options.readCap();
    },
    locate: (text) => {
      const trimmed = text.trim();
      const ref = parseRef(trimmed);
      const workspaces = options.attached();
      if (ref) {
        if (ref.location !== "workspace") {
          return {
            error: `${trimmed} is not a workspace file. Use the files tools for session, project and global files.`,
          };
        }
        const w = workspaces.find((x) => x.id === ref.workspaceId);
        if (!w) {
          return {
            error: `No workspace with the id ${ref.workspaceId} is attached to this session. Call workspaces_list.`,
          };
        }
        return { workspace: info(w), path: ref.path.replace(/^\/+/, "") };
      }
      const [only, ...more] = workspaces;
      if (!only) return { error: "This session has no workspaces." };
      if (more.length > 0) {
        return {
          error:
            "There is more than one workspace. Write the path as a reference, workspace://<id>/path. Call workspaces_list for the ids.",
        };
      }
      return { workspace: info(only), path: trimmed.replace(/^\/+/, "") };
    },

    listDir: async (id, path, o) => {
      const w = find(id);
      const root = resolveIn(w.path, path, opts(o));
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new WorkspaceError("not_found", `There is no folder "${path}".`);
      }
      const out: WorkspaceEntry[] = [];
      const walk = (dirAbs: string, dirRel: string) => {
        const names = readdirSync(dirAbs).sort();
        for (const name of names) {
          if (out.length >= LIST_LIMIT) return;
          const abs = join(dirAbs, name);
          const rel = dirRel === "" ? name : `${dirRel}/${name}`;
          const entry = fileOf(rel, name, abs);
          if (!entry) continue;
          out.push(entry);
          // A link to a folder is shown but not followed.
          if (
            o?.recursive &&
            entry.kind === "folder" &&
            !lstatSync(abs).isSymbolicLink()
          ) {
            walk(abs, rel);
          }
        }
      };
      walk(root, path.replace(/\/+$/, ""));
      return out;
    },

    read: async (id, path, o) => {
      const w = find(id);
      if (path === "") {
        throw new WorkspaceError(
          "invalid",
          "Name a file. The root is a folder.",
        );
      }
      const abs = resolveIn(w.path, path, opts(o));
      if (!existsSync(abs)) {
        throw new WorkspaceError("not_found", `There is no file "${path}".`);
      }
      const s = statSync(abs);
      if (s.isDirectory()) {
        throw new WorkspaceError(
          "invalid",
          `"${path}" is a folder. List it with workspace_list.`,
        );
      }
      const media = typeByName(path);
      const isMediaExt =
        media?.startsWith("image/") || media?.startsWith("audio/");
      if (s.size > (isMediaExt ? MAX_UPLOAD_BYTES : MAX_TEXT_BYTES)) {
        throw new WorkspaceError(
          "too_large",
          `"${path}" is too large to read (${s.size} bytes).`,
        );
      }
      const data = readFileSync(abs);
      const kind = classify(path, data);
      record(id, path, s);
      if (kind.kind === "media") {
        return { kind: "media", mediaType: kind.mediaType, size: s.size };
      }
      if (kind.kind === "binary") return { kind: "binary", size: s.size };
      const text = data.toString("utf8");
      const chars = [...text];
      const offset = Math.min(Math.max(0, o?.offset ?? 0), chars.length);
      const limit = Math.min(o?.limit ?? options.readCap(), options.readCap());
      return {
        kind: "text",
        mediaType: kind.mediaType,
        text: chars.slice(offset, offset + limit).join(""),
        offset,
        total: chars.length,
      } satisfies WorkspaceRead;
    },

    write: async (id, path, content, o) => {
      const w = find(id);
      writable(w);
      if (path === "") throw new WorkspaceError("invalid", "Name a file.");
      const abs = resolveIn(w.path, path, opts(o));
      const exists = existsSync(abs);
      if (exists) {
        if (statSync(abs).isDirectory()) {
          throw new WorkspaceError("invalid", `"${path}" is a folder.`);
        }
        checkFresh(id, path, abs);
      } else {
        newName(path, o);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      const s = statSync(abs);
      record(id, path, s);
      return { created: !exists, size: s.size };
    },

    edit: async (id, path, oldText, newText, o) => {
      const w = find(id);
      writable(w);
      if (oldText === "") {
        throw new WorkspaceError("invalid", "The text to replace is empty.");
      }
      const abs = resolveIn(w.path, path, opts(o));
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new WorkspaceError("not_found", `There is no file "${path}".`);
      }
      checkFresh(id, path, abs);
      const data = readFileSync(abs);
      if (classify(path, data).kind !== "text") {
        throw new WorkspaceError("not_text", `"${path}" is not a text file.`);
      }
      const text = data.toString("utf8");
      const count = text.split(oldText).length - 1;
      if (count === 0) {
        throw new WorkspaceError(
          "invalid",
          `That text is not in "${path}". Read the file again and copy it exactly.`,
        );
      }
      if (count > 1 && !o?.replaceAll) {
        throw new WorkspaceError(
          "invalid",
          `That text is in "${path}" ${count} times. Include more around it, or set replaceAll.`,
        );
      }
      writeFileSync(abs, text.split(oldText).join(newText), "utf8");
      record(id, path, statSync(abs));
      return { replacements: o?.replaceAll ? count : 1 };
    },

    move: async (id, from, to, o) => {
      const w = find(id);
      writable(w);
      if (from === "" || to === "") {
        throw new WorkspaceError("invalid", "Name the file to move and where.");
      }
      const a = resolveIn(w.path, from, opts(o));
      const b = resolveIn(w.path, to, opts(o));
      if (!existsSync(a)) {
        throw new WorkspaceError("not_found", `There is no file "${from}".`);
      }
      if (statSync(a).isDirectory()) {
        throw new WorkspaceError(
          "invalid",
          `"${from}" is a folder. Use workspace_folder_rename.`,
        );
      }
      if (existsSync(b)) {
        throw new WorkspaceError("exists", `"${to}" already exists.`);
      }
      newName(to, o);
      mkdirSync(dirname(b), { recursive: true });
      renameSync(a, b);
      options.reads.delete(key(id, from));
    },

    remove: async (id, path, o) => {
      const w = find(id);
      writable(w);
      if (path === "") throw new WorkspaceError("invalid", "Name a file.");
      const abs = resolveIn(w.path, path, opts(o));
      if (!existsSync(abs) && !lstatExists(abs)) {
        throw new WorkspaceError("not_found", `There is no file "${path}".`);
      }
      if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
        throw new WorkspaceError(
          "invalid",
          `"${path}" is a folder. Use workspace_folder_delete.`,
        );
      }
      rmSync(abs);
      options.reads.delete(key(id, path));
    },

    createFolder: async (id, path, o) => {
      const w = find(id);
      writable(w);
      if (path === "") throw new WorkspaceError("invalid", "Name a folder.");
      const abs = resolveIn(w.path, path, opts(o));
      if (existsSync(abs)) {
        if (statSync(abs).isDirectory()) return false;
        throw new WorkspaceError("exists", `"${path}" is a file.`);
      }
      newName(path, o);
      mkdirSync(abs, { recursive: true });
      return true;
    },

    moveFolder: async (id, from, to, o) => {
      const w = find(id);
      writable(w);
      if (from === "" || to === "") {
        throw new WorkspaceError(
          "invalid",
          "Name the folder and its new path.",
        );
      }
      const a = resolveIn(w.path, from, opts(o));
      const b = resolveIn(w.path, to, opts(o));
      if (!existsSync(a) || !statSync(a).isDirectory()) {
        throw new WorkspaceError("not_found", `There is no folder "${from}".`);
      }
      if (existsSync(b)) {
        throw new WorkspaceError("exists", `"${to}" already exists.`);
      }
      if (within(a, b)) {
        throw new WorkspaceError(
          "invalid",
          "A folder cannot move into itself.",
        );
      }
      newName(to, o);
      mkdirSync(dirname(b), { recursive: true });
      renameSync(a, b);
      // What was read under the old path is no longer at it.
      for (const k of [...options.reads.keys()]) {
        if (k.startsWith(key(id, `${from}/`))) options.reads.delete(k);
      }
    },

    search: async (query, limit, signal) => {
      const attached = options.attached();
      const indexed = attached.map((w) => ({
        workspace: info(w),
        files: options.index?.files(w.id) ?? 0,
      }));
      const ids = attached.filter((w) => w.ticks.length > 0).map((w) => w.id);
      if (!options.index || ids.length === 0) {
        return { hits: [], mode: "keyword", indexed };
      }
      const found = await options.index.search({
        query,
        limit,
        workspaceIds: ids,
        ...(signal ? { signal } : {}),
      });
      const byId = new Map(attached.map((w) => [w.id, w]));
      return {
        hits: found.hits.flatMap((h) => {
          const w = byId.get(h.workspaceId);
          return w
            ? [
                {
                  workspace: info(w),
                  path: h.path,
                  excerpt: h.excerpt,
                  matched: h.matched,
                },
              ]
            : [];
        }),
        mode: found.mode,
        ...(found.notice !== undefined ? { notice: found.notice } : {}),
        indexed,
      };
    },

    deleteFolder: async (id, path, o) => {
      const w = find(id);
      writable(w);
      if (path === "") {
        throw new WorkspaceError(
          "invalid",
          "The workspace root cannot be deleted.",
        );
      }
      const abs = resolveIn(w.path, path, opts(o));
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new WorkspaceError("not_found", `There is no folder "${path}".`);
      }
      const files = countFiles(abs);
      if (!o?.recursive && readdirSync(abs).length > 0) {
        throw new WorkspaceError(
          "not_empty",
          `"${path}" is not empty (${files} ${files === 1 ? "file" : "files"}). Set recursive to delete it with everything in it.`,
        );
      }
      rmSync(abs, { recursive: true });
      for (const k of [...options.reads.keys()]) {
        if (k.startsWith(key(id, `${path}/`))) options.reads.delete(k);
      }
      return { files };
    },
  };
}

/** True for a link whose target is gone: it exists as an entry. */
function lstatExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const s = lstatSync(abs);
    if (s.isDirectory() && !s.isSymbolicLink()) n += countFiles(abs);
    else n++;
  }
  return n;
}

/**
 * A media file in a workspace the session has, for a model request: its media
 * type by name, and its bytes when asked for (D48). Undefined when the
 * workspace is not attached, the path leaves the folder, or the file is not an
 * image or audio file within the size cap.
 */
export function workspaceMediaSource(
  attached: () => AttachedWorkspace[],
): (
  id: string,
  path: string,
) => { mediaType: string; bytes: () => Buffer | undefined } | undefined {
  return (id, path) => {
    const w = attached().find((x) => x.id === id);
    const declared = typeByName(path);
    if (!w || !declared) return undefined;
    if (!declared.startsWith("image/") && !declared.startsWith("audio/")) {
      return undefined;
    }
    try {
      const abs = resolveIn(w.path, path);
      const s = statSync(abs);
      if (!s.isFile() || s.size > MAX_UPLOAD_BYTES) return undefined;
      return {
        mediaType: declared,
        bytes: () => {
          try {
            const data = readFileSync(abs);
            const found = detectMedia(declared, data);
            return found ? data : undefined;
          } catch {
            return undefined;
          }
        },
      };
    } catch {
      return undefined;
    }
  };
}
