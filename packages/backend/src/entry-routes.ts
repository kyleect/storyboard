import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  checkFileKey,
  checkFileValue,
  EntryKind,
  FileType,
  replaySessionEntries,
  sessionEntryVersions,
  type EntryOp,
} from "@harness/core";
import type { EntryStore, VersionRow } from "./entries-store.js";
import { RunError, type RunManager } from "./runs.js";
import type { Store } from "./store.js";

/*
 * Routes for viewing and editing files and memory notes in the app (files
 * and memory design, decisions 2, 8 and 34). The same routes exist under
 * three bases:
 *
 *   /api/global                    global entries
 *   /api/projects/:projectId       a project's entries
 *   /api/sessions/:sessionId       a session's entries (from the transcript)
 *
 * Under each: GET files, GET/PUT/DELETE files/:key, POST files/:key/restore;
 * GET notes, GET/PATCH/DELETE notes/:id, POST notes/:id/restore. The user
 * creates files but not notes: only the model creates notes.
 */

export interface EntryVersion {
  seq: number;
  /** Files only. */
  type?: FileType;
  /** For a deletion, the value at the time. */
  value: string;
  deleted: boolean;
  by: "user" | "model";
  /** For a model change: the session and run that made it, when known. */
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface EntrySummary {
  key: string;
  type?: FileType;
  value: string;
  updatedAt: string;
  deleted: boolean;
}

export interface EntryDetail extends EntrySummary {
  versions: EntryVersion[];
}

/** One scope's entries, as the routes see them. */
interface ScopeApi {
  list(kind: EntryKind, includeDeleted: boolean): EntrySummary[];
  get(kind: EntryKind, key: string): EntryDetail | undefined;
  put(
    kind: EntryKind,
    entry: { key: string; value: string; type?: FileType },
  ): void;
  delete(kind: EntryKind, key: string): void;
}

const notFound = (kind: EntryKind, key: string) =>
  new RunError(
    kind === "file" ? `No file "${key}".` : `No memory note "${key}".`,
    404,
  );

function sharedScope(entries: EntryStore, projectId: string | null): ScopeApi {
  const toVersion = (v: VersionRow): EntryVersion => ({
    seq: v.seq,
    ...(v.type ? { type: v.type } : {}),
    value: v.value,
    deleted: v.deleted === 1,
    by: v.author,
    sessionId: v.session_id,
    runId: v.run_id,
    createdAt: v.created_at,
  });
  return {
    list: (kind, includeDeleted) =>
      entries.list(kind, projectId, includeDeleted).map((r) => ({
        key: r.key,
        ...(r.type ? { type: r.type } : {}),
        value: r.value,
        updatedAt: r.updated_at,
        deleted: r.deleted_at !== null,
      })),
    get: (kind, key) => {
      const r = entries.get(kind, projectId, key);
      if (!r) return undefined;
      return {
        key: r.key,
        ...(r.type ? { type: r.type } : {}),
        value: r.value,
        updatedAt: r.updated_at,
        deleted: r.deleted_at !== null,
        versions: entries.versions(kind, projectId, key).map(toVersion),
      };
    },
    put: (kind, entry) => {
      entries.put(kind, projectId, entry, { by: "user" });
    },
    delete: (kind, key) => {
      if (!entries.delete(kind, projectId, key, { by: "user" })) {
        throw notFound(kind, key);
      }
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
    kind: EntryKind,
    key: string,
  ): EntryDetail | undefined => {
    const changes = sessionEntryVersions(messages, kind, key);
    if (changes.length === 0) return undefined;
    let value = "";
    let type: FileType | undefined;
    const versions = changes.map((c, i): EntryVersion => {
      if (c.op.op === "put") {
        value = c.op.value;
        type = c.op.type;
      }
      return {
        seq: i + 1,
        ...(type ? { type } : {}),
        value,
        deleted: c.op.op === "delete",
        by: c.by,
        sessionId: c.by === "model" ? sessionId : null,
        runId: c.by === "model" ? (runOf.get(c.messageId) ?? null) : null,
        createdAt: times.get(c.messageId) ?? "",
      };
    });
    const current = versions.at(-1) as EntryVersion;
    return {
      key,
      ...(current.type ? { type: current.type } : {}),
      value: current.value,
      updatedAt: current.createdAt,
      deleted: current.deleted,
      versions,
    };
  };
  const edit = (op: EntryOp) => runs.editSessionEntries(sessionId, [op]);
  return {
    list: (kind, includeDeleted) => {
      const messages = store.listMessages(sessionId);
      const runOf = store.messageRuns(sessionId);
      const times = store.messageTimes(sessionId);
      const state = replaySessionEntries(messages.map((m) => m.message));
      return [...state.used[kind]]
        .sort()
        .map((key) => detail(messages, runOf, times, kind, key) as EntryDetail)
        .filter((d) => includeDeleted || !d.deleted)
        .map((d): EntrySummary => ({
          key: d.key,
          ...(d.type ? { type: d.type } : {}),
          value: d.value,
          updatedAt: d.updatedAt,
          deleted: d.deleted,
        }));
    },
    get: (kind, key) =>
      detail(
        store.listMessages(sessionId),
        store.messageRuns(sessionId),
        store.messageTimes(sessionId),
        kind,
        key,
      ),
    put: (kind, entry) => {
      edit({ op: "put", kind, ...entry });
    },
    delete: (kind, key) => {
      const messages = store.listMessages(sessionId).map((m) => m.message);
      if (!replaySessionEntries(messages)[kind].has(key)) {
        throw notFound(kind, key);
      }
      edit({ op: "delete", kind, key });
    },
  };
}

const ListQuery = z.object({
  deleted: z.enum(["true", "false"]).optional(),
});
const FileBody = z.object({ type: FileType, value: z.string() });
const NoteBody = z.object({ text: z.string().min(1) });
const RestoreBody = z.object({ seq: z.number().int().min(1) });

export function registerEntryRoutes(
  app: FastifyInstance,
  deps: { store: Store; runs: RunManager; entries: EntryStore },
) {
  const { store, runs, entries } = deps;

  const project = (req: FastifyRequest): ScopeApi => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    const row = store.getProject(projectId);
    if (!row) throw new RunError("Project not found.", 404);
    return sharedScope(entries, projectId);
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
    ["/api/global", () => sharedScope(entries, null)],
    ["/api/projects/:projectId", project],
    ["/api/sessions/:sessionId", session],
  ];

  for (const [base, scopeOf] of bases) {
    for (const kind of EntryKind.options) {
      const path = `${base}/${kind === "file" ? "files" : "notes"}`;
      const param = kind === "file" ? "key" : "id";
      const keyOf = (req: FastifyRequest) => {
        const key = (req.params as Record<string, string>)[param] ?? "";
        if (kind === "file") checkFileKey(key);
        return key;
      };
      const existing = (req: FastifyRequest) => {
        const key = keyOf(req);
        const entry = scopeOf(req).get(kind, key);
        if (!entry) throw notFound(kind, key);
        return entry;
      };

      app.get(path, async (req) => {
        const q = ListQuery.parse(req.query);
        return scopeOf(req).list(kind, q.deleted === "true");
      });

      app.get(`${path}/:${param}`, async (req) => existing(req));

      if (kind === "file") {
        app.put(`${path}/:${param}`, async (req) => {
          writable(req);
          const key = keyOf(req);
          const body = FileBody.parse(req.body);
          checkFileValue(body.type, body.value);
          const scope = scopeOf(req);
          scope.put(kind, { key, value: body.value, type: body.type });
          return scope.get(kind, key);
        });
      } else {
        app.patch(`${path}/:${param}`, async (req) => {
          writable(req);
          const entry = existing(req);
          if (entry.deleted) {
            throw new RunError(
              "The note is deleted. Restore a version first.",
              409,
            );
          }
          const body = NoteBody.parse(req.body);
          const scope = scopeOf(req);
          scope.put(kind, { key: entry.key, value: body.text });
          return scope.get(kind, entry.key);
        });
      }

      app.delete(`${path}/:${param}`, async (req, reply) => {
        writable(req);
        scopeOf(req).delete(kind, keyOf(req));
        return reply.code(204).send();
      });

      /** Makes an earlier version current; also restores a deleted entry. */
      app.post(`${path}/:${param}/restore`, async (req) => {
        writable(req);
        const entry = existing(req);
        const { seq } = RestoreBody.parse(req.body);
        const version = entry.versions.find((v) => v.seq === seq);
        if (!version) throw new RunError(`No version ${seq}.`, 404);
        if (version.deleted) {
          throw new RunError(
            "That version is a deletion; pick a version with a value.",
            400,
          );
        }
        const scope = scopeOf(req);
        scope.put(kind, {
          key: entry.key,
          value: version.value,
          ...(version.type ? { type: version.type } : {}),
        });
        return scope.get(kind, entry.key);
      });
    }
  }
}
