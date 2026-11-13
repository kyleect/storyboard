import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  checkFileName,
  checkFileValue,
  createFileAccess,
  type BlobRef,
  type FileAccess,
  isBinaryMediaType,
  MediaType,
  plainRef,
  replaySessionFiles,
  sessionFileVersions,
  type FileOp,
} from "@harness/core";
import { getBlob, putBlob } from "./blobs.js";
import {
  DERIVED_TEXT_MAX,
  getDerived,
  type MediaDescriber,
} from "./media-describer.js";
import { blobOf, type FileStore, type VersionRow } from "./files-store.js";
import { detectMedia, MAX_UPLOAD_BYTES } from "./media-detect.js";
import { RunError, type RunManager } from "./runs.js";
import type { Store } from "./store.js";

/*
 * Routes for viewing and editing files in the app (files and memory
 * design, decisions 2, 8 and 34). The same routes exist under
 * three bases:
 *
 *   /api/global                    global files
 *   /api/projects/:projectId       a project's files
 *   /api/sessions/:sessionId       a session's files (from the transcript)
 *
 * Under each: GET files, GET/PUT/DELETE files/:key, POST files/:key/restore.
 *
 * Binary files (images and audio) are added with
 *
 *   POST <base>/files?name=&replace=      the file as the request body
 *   GET  /api/blobs/:hash                 the bytes under a hash
 *
 * An upload's Content-Type is its media type and the bytes must match it
 * (`media-detect.ts`). `name` is the file's path in the scope, left out for
 * a name the app makes (`image-2026-11-07-1432.png`). A name already in use
 * gets a suffix (`cat (2).png`) unless `replace=true`. It answers 201 with
 * the file's key, reference, media type, size and bytes, 400 for a bad name,
 * an empty file or one that is not what its type says, 413 over 20 MiB and
 * 415 for a type that is not accepted. Text files are saved with PUT and
 * their value; a binary media type there is refused (400).
 */

export interface FileVersion {
  seq: number;
  /** Files only. */
  mediaType?: MediaType;
  /** For a deletion, the value at the time. Empty for a binary file. */
  value: string;
  /** Binary files: the bytes of this version. */
  blob?: BlobRef;
  deleted: boolean;
  by: "user" | "model";
  /** For a model change: the session and run that made it, when known. */
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface FileSummary {
  key: string;
  mediaType?: MediaType;
  /** Empty for a binary file. */
  value: string;
  /** Binary files: the bytes (`GET /api/blobs/:hash`). */
  blob?: BlobRef;
  updatedAt: string;
  deleted: boolean;
}

export interface FileDetail extends FileSummary {
  versions: FileVersion[];
}

/** One scope's files, as the routes see them. */
interface ScopeApi {
  list(includeDeleted: boolean): FileSummary[];
  get(key: string): FileDetail | undefined;
  put(file: {
    key: string;
    value: string;
    mediaType?: MediaType;
    blob?: BlobRef;
  }): void;
  /** Adds or replaces a binary file whose bytes are stored. */
  putBlob(key: string, mediaType: MediaType, blob: BlobRef): void;
  delete(key: string): void;
  /** Every folder, explicit or holding files. */
  folders(): string[];
  /** False when the folder already exists. */
  createFolder(path: string): boolean;
  renameFolder(path: string, newPath: string): void;
  deleteFolder(path: string): void;
}

const folderNotFound = (path: string) =>
  new RunError(`No folder "${path}".`, 404);

const notFound = (key: string) => new RunError(`No file "${key}".`, 404);

function sharedScope(files: FileStore, projectId: string | null): ScopeApi {
  const scope = projectId === null ? "global" : "project";
  // Folder rules (names, clashes, what moves) live in the core access, as for
  // the tools; the user's changes go through the same code.
  const access = (): FileAccess =>
    createFileAccess({
      session: replaySessionFiles([]),
      sessionOps: [],
      shared: files.shared(projectId),
      inProject: projectId !== null,
      author: { by: "user" },
    });
  const toVersion = (v: VersionRow): FileVersion => ({
    seq: v.seq,
    ...(v.media_type ? { mediaType: v.media_type } : {}),
    value: v.value,
    ...(blobOf(v) ? { blob: blobOf(v) as BlobRef } : {}),
    deleted: v.deleted === 1,
    by: v.author,
    sessionId: v.session_id,
    runId: v.run_id,
    createdAt: v.created_at,
  });
  return {
    list: (includeDeleted) =>
      files.list(projectId, includeDeleted).map((r) => ({
        key: r.key,
        ...(r.media_type ? { mediaType: r.media_type } : {}),
        value: r.value,
        ...(blobOf(r) ? { blob: blobOf(r) as BlobRef } : {}),
        updatedAt: r.updated_at,
        deleted: r.deleted_at !== null,
      })),
    get: (key) => {
      const r = files.get(projectId, key);
      if (!r) return undefined;
      return {
        key: r.key,
        ...(r.media_type ? { mediaType: r.media_type } : {}),
        value: r.value,
        ...(blobOf(r) ? { blob: blobOf(r) as BlobRef } : {}),
        updatedAt: r.updated_at,
        deleted: r.deleted_at !== null,
        versions: files.versions(projectId, key).map(toVersion),
      };
    },
    put: (file) => {
      files.put(projectId, file, { by: "user" });
    },
    putBlob: (key, mediaType, blob) => {
      access().putBlob(scope, key, mediaType, blob);
    },
    delete: (key) => {
      if (!files.delete(projectId, key, { by: "user" })) {
        throw notFound(key);
      }
    },
    folders: () =>
      access()
        .listFolders(scope)
        .map((f) => f.path),
    createFolder: (path) => access().createFolder(scope, path),
    renameFolder: (path, newPath) => {
      if (!access().renameFolder(scope, path, newPath)) {
        throw folderNotFound(path);
      }
    },
    deleteFolder: (path) => {
      if (!access().deleteFolder(scope, path)) throw folderNotFound(path);
    },
  };
}

function sessionScope(
  store: Store,
  runs: RunManager,
  sessionId: string,
): ScopeApi {
  type Messages = ReturnType<Store["listMessages"]>;
  const detail = (
    messages: Messages,
    runOf: Map<string, string>,
    times: Map<string, string>,
    key: string,
  ): FileDetail | undefined => {
    const changes = sessionFileVersions(messages, key);
    if (changes.length === 0) return undefined;
    let value = "";
    let mediaType: MediaType | undefined;
    let blob: BlobRef | undefined;
    const versions = changes.map((c, i): FileVersion => {
      if (c.op.op === "put") {
        value = c.op.value;
        mediaType = c.op.mediaType;
        blob = c.op.blob;
      }
      return {
        seq: i + 1,
        ...(mediaType ? { mediaType } : {}),
        value,
        ...(blob ? { blob } : {}),
        deleted: c.op.op === "delete",
        by: c.by,
        sessionId: c.by === "model" ? sessionId : null,
        runId: c.by === "model" ? (runOf.get(c.messageId) ?? null) : null,
        createdAt: times.get(c.messageId) ?? "",
      };
    });
    const current = versions.at(-1) as FileVersion;
    return {
      key,
      ...(current.mediaType ? { mediaType: current.mediaType } : {}),
      value: current.value,
      ...(current.blob ? { blob: current.blob } : {}),
      updatedAt: current.createdAt,
      deleted: current.deleted,
      versions,
    };
  };
  const edit = (op: FileOp) => runs.editSessionFiles(sessionId, [op]);
  /** Runs a folder change in the core access and records the operations. */
  const change = <T>(run: (access: FileAccess) => T): T => {
    const sessionOps: FileOp[] = [];
    const result = run(
      createFileAccess({
        session: replaySessionFiles(
          store.listMessages(sessionId).map((m) => m.message),
        ),
        sessionOps,
        inProject: false,
        author: { by: "user" },
      }),
    );
    if (sessionOps.length > 0) runs.editSessionFiles(sessionId, sessionOps);
    return result;
  };
  return {
    list: (includeDeleted) => {
      const messages = store.listMessages(sessionId);
      const runOf = store.messageRuns(sessionId);
      const times = store.messageTimes(sessionId);
      const state = replaySessionFiles(messages.map((m) => m.message));
      return [...state.used]
        .sort()
        .map((key) => detail(messages, runOf, times, key) as FileDetail)
        .filter((d) => includeDeleted || !d.deleted)
        .map((d): FileSummary => ({
          key: d.key,
          ...(d.mediaType ? { mediaType: d.mediaType } : {}),
          value: d.value,
          ...(d.blob ? { blob: d.blob } : {}),
          updatedAt: d.updatedAt,
          deleted: d.deleted,
        }));
    },
    get: (key) =>
      detail(
        store.listMessages(sessionId),
        store.messageRuns(sessionId),
        store.messageTimes(sessionId),
        key,
      ),
    put: (file) => {
      edit({ op: "put", ...file });
    },
    putBlob: (key, mediaType, blob) => {
      change((a) => a.putBlob("session", key, mediaType, blob));
    },
    delete: (key) => {
      const messages = store.listMessages(sessionId).map((m) => m.message);
      if (!replaySessionFiles(messages).files.has(key)) throw notFound(key);
      edit({ op: "delete", key });
    },
    folders: () => change((a) => a.listFolders("session").map((f) => f.path)),
    createFolder: (path) => change((a) => a.createFolder("session", path)),
    renameFolder: (path, newPath) => {
      if (!change((a) => a.renameFolder("session", path, newPath))) {
        throw folderNotFound(path);
      }
    },
    deleteFolder: (path) => {
      if (!change((a) => a.deleteFolder("session", path))) {
        throw folderNotFound(path);
      }
    },
  };
}

const ListQuery = z.object({
  deleted: z.enum(["true", "false"]).optional(),
});
const FileBody = z.object({ mediaType: MediaType, value: z.string() });
const UploadQuery = z.object({
  name: z.string().min(1).max(1024).optional(),
  replace: z.enum(["true", "false"]).optional(),
});

/** `cat.png` taken: `cat (2).png`, `cat (3).png`, and so on. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const slash = name.lastIndexOf("/") + 1;
  const dot = name.indexOf(".", slash + 1);
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
const FolderBody = z.object({ path: z.string() });
const FolderRenameBody = z.object({ path: z.string(), newPath: z.string() });
const RestoreBody = z.object({ seq: z.number().int().min(1) });

export function registerFileRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    runs: RunManager;
    files: FileStore;
    /** Describes an uploaded image or audio file in the background. */
    describer?: MediaDescriber;
    now?: () => string;
  },
) {
  const { store, runs, files } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  // Without this, Fastify refuses image and audio bodies. The body stays a
  // Buffer; the route checks what it holds.
  app.addContentTypeParser(
    /^(image|audio)\//,
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get("/api/blobs/:hash", async (req, reply) => {
    const { hash } = z.object({ hash: z.string() }).parse(req.params);
    const blob = getBlob(files.db, hash);
    if (!blob)
      return reply.code(404).send({ error: "File content not found." });
    return (
      reply
        .header("content-type", blob.mediaType)
        .header("x-content-type-options", "nosniff")
        // The bytes under a hash never change.
        .header("cache-control", "private, max-age=31536000, immutable")
        .send(blob.data)
    );
  });

  // Derived text of an image or audio file (files unification design, D18,
  // D43, D44, D56). It belongs to the bytes, so the routes name a hash.
  const describer = deps.describer;
  const HashParams = z.object({ hash: z.string() });

  /** The text and where it came from: none, pending, generated, edited, failed. */
  app.get("/api/blobs/:hash/derived-text", async (req, reply) => {
    const { hash } = HashParams.parse(req.params);
    const derived = getDerived(files.db, hash);
    if (!derived)
      return reply.code(404).send({ error: "File content not found." });
    return derived;
  });

  /** The user's text for the file. Empty text clears it. */
  app.put("/api/blobs/:hash/derived-text", async (req, reply) => {
    const { hash } = HashParams.parse(req.params);
    const { text } = z
      .object({ text: z.string().max(DERIVED_TEXT_MAX) })
      .parse(req.body);
    if (!describer?.setText(hash, text)) {
      return reply.code(404).send({ error: "File content not found." });
    }
    return getDerived(files.db, hash);
  });

  /** Writes the text again with the Media Describer (Retry). 202 when queued. */
  app.post("/api/blobs/:hash/describe", async (req, reply) => {
    const { hash } = HashParams.parse(req.params);
    if (!getDerived(files.db, hash)) {
      return reply.code(404).send({ error: "File content not found." });
    }
    if (!describer?.enabled()) {
      return reply.code(409).send({
        error:
          "Descriptions are off. Choose a Media describer model and agent in Settings.",
      });
    }
    if (!describer.retry(hash)) {
      return reply
        .code(409)
        .send({ error: "A description is already being written." });
    }
    return reply.code(202).send(getDerived(files.db, hash));
  });

  /**
   * What a change of the describer settings would touch: how many image and
   * audio files there are and how many have no text. The app asks the user
   * before it regenerates anything (D56).
   */
  app.get("/api/media-describer", async () => ({
    enabled: describer?.enabled() ?? false,
    ...(describer?.counts() ?? { files: 0, empty: 0 }),
  }));

  /** The answer to that question: `empty`, or `all` except edited text. */
  app.post("/api/media-describer/regenerate", async (req, reply) => {
    const { mode } = z
      .object({ mode: z.enum(["empty", "all"]) })
      .parse(req.body);
    if (!describer?.enabled()) {
      return reply.code(409).send({ error: "Descriptions are off." });
    }
    return reply.code(202).send({ queued: describer.regenerate(mode) });
  });

  const project = (req: FastifyRequest): ScopeApi => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    const row = store.getProject(projectId);
    if (!row) throw new RunError("Project not found.", 404);
    return sharedScope(files, projectId);
  };
  const session = (req: FastifyRequest): ScopeApi => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.params);
    if (!store.getSession(sessionId)) {
      throw new RunError("Session not found.", 404);
    }
    return sessionScope(store, runs, sessionId);
  };
  /** Project or session in the trash: read-only. */
  const writable = (req: FastifyRequest) => {
    const p = req.params as { projectId?: string; sessionId?: string };
    if (p.projectId && store.getProject(p.projectId)?.trashed_at) {
      throw new RunError("The project is in the trash.", 409);
    }
    // Sessions: the run manager refuses trashed sessions and active runs.
  };

  const bases: [string, (req: FastifyRequest) => ScopeApi][] = [
    ["/api/global", () => sharedScope(files, null)],
    ["/api/projects/:projectId", project],
    ["/api/sessions/:sessionId", session],
  ];

  for (const [base, scopeOf] of bases) {
    app.get(`${base}/folders`, async (req) => scopeOf(req).folders());
    app.post(`${base}/folders`, async (req, reply) => {
      writable(req);
      const { path } = FolderBody.parse(req.body);
      const created = scopeOf(req).createFolder(path);
      return reply.code(created ? 201 : 200).send({ path, created });
    });
    app.post(`${base}/folders/rename`, async (req) => {
      writable(req);
      const { path, newPath } = FolderRenameBody.parse(req.body);
      scopeOf(req).renameFolder(path, newPath);
      return { path: newPath };
    });
    app.post(`${base}/folders/delete`, async (req, reply) => {
      writable(req);
      const { path } = FolderBody.parse(req.body);
      scopeOf(req).deleteFolder(path);
      return reply.code(204).send();
    });
    app.post(
      `${base}/files`,
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (req, reply) => {
        writable(req);
        const query = UploadQuery.parse(req.query);
        const body = req.body;
        // Fastify's own parsers turn text and JSON bodies into strings and
        // objects; only an image or audio Content-Type gives the raw bytes.
        if (body !== undefined && !Buffer.isBuffer(body)) {
          return reply.code(415).send({
            error:
              "Send the file itself as the request body, with its media type as the Content-Type.",
          });
        }
        if (body === undefined || body.length === 0) {
          return reply.code(400).send({ error: "The file is empty." });
        }
        const found = detectMedia(req.headers["content-type"] ?? "", body);
        if (!found) {
          return reply.code(400).send({
            error:
              "The file is not a PNG, JPEG, GIF or BMP image, or a WAV, MP3 or FLAC audio file, or its content does not match its type.",
          });
        }
        const scope = scopeOf(req);
        const stamp = now().slice(0, 16).replace("T", "-").replace(":", "");
        const wanted =
          query.name ??
          `${found.kind === "image" ? "image" : "recording"}-${stamp}.${found.extension}`;
        checkFileName(wanted);
        const replace = query.replace === "true";
        const taken = new Set([
          ...scope.list(false).map((f) => f.key),
          ...scope.folders(),
        ]);
        const key = replace ? wanted : freeName(wanted, taken);
        checkFileName(key);
        const replaced = replace && taken.has(key);
        const blob = putBlob(files.db, found.mediaType, body, now());
        scope.putBlob(key, found.mediaType, blob);
        // Written after the file is saved; the Files view shows it pending.
        deps.describer?.describeNew(blob.hash);
        const params = req.params as { sessionId?: string; projectId?: string };
        const location = params.sessionId
          ? "session"
          : params.projectId
            ? "project"
            : "global";
        return reply.code(201).send({
          key,
          ref: plainRef({ location, path: key }),
          mediaType: found.mediaType,
          size: blob.size,
          blob,
          replaced,
        });
      },
    );
    const path = `${base}/files`;
    const param = "key";
    const keyOf = (req: FastifyRequest) => {
      const key = (req.params as Record<string, string>)[param] ?? "";
      checkFileName(key);
      return key;
    };
    const existing = (req: FastifyRequest) => {
      const key = keyOf(req);
      const file = scopeOf(req).get(key);
      if (!file) throw notFound(key);
      return file;
    };

    app.get(path, async (req) => {
      const q = ListQuery.parse(req.query);
      return scopeOf(req).list(q.deleted === "true");
    });

    app.get(`${path}/:${param}`, async (req) => existing(req));

    app.put(`${path}/:${param}`, async (req) => {
      writable(req);
      const key = keyOf(req);
      const body = FileBody.parse(req.body);
      if (isBinaryMediaType(body.mediaType)) {
        throw new RunError(
          "Binary files are added by upload (POST …/files with the file as the body), not saved as text.",
          400,
        );
      }
      checkFileValue(body.mediaType, body.value);
      const scope = scopeOf(req);
      scope.put({
        key,
        value: body.value,
        mediaType: body.mediaType,
      });
      return scope.get(key);
    });

    app.delete(`${path}/:${param}`, async (req, reply) => {
      writable(req);
      scopeOf(req).delete(keyOf(req));
      return reply.code(204).send();
    });

    /** Makes an earlier version current; also restores a deleted file. */
    app.post(`${path}/:${param}/restore`, async (req) => {
      writable(req);
      const file = existing(req);
      const { seq } = RestoreBody.parse(req.body);
      const version = file.versions.find((v) => v.seq === seq);
      if (!version) throw new RunError(`No version ${seq}.`, 404);
      if (version.deleted) {
        throw new RunError(
          "That version is a deletion; pick a version with a value.",
          400,
        );
      }
      const scope = scopeOf(req);
      scope.put({
        key: file.key,
        value: version.value,
        ...(version.mediaType ? { mediaType: version.mediaType } : {}),
        ...(version.blob ? { blob: version.blob } : {}),
      });
      return scope.get(file.key);
    });
  }
}
