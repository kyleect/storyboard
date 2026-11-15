import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppEvents } from "./app-events.js";
import type { Store } from "./store.js";
import {
  previewFile,
  resolveIn,
  walkWorkspace,
  workspaceMediaSource,
} from "./workspace-fs.js";
import type { WorkspaceIndexer } from "./workspace-index.js";
import { normalizeTicks, tickState, toggleTick } from "./workspace-ticks.js";
import {
  WorkspaceStoreError,
  type WorkspaceOwner,
  type WorkspaceStore,
} from "./workspaces-store.js";
import { WorkspaceError } from "@harness/core";

/*
 * Routes for workspaces (files unification design, D22 to D26, D46;
 * workspaces in files design, Q1 to Q12). A workspace is defined at a scope,
 * like files:
 *
 *   GET    /api/{global|projects/:id|sessions/:id}/workspaces   ?deleted=true: the trash
 *   POST   /api/{global|projects/:id|sessions/:id}/workspaces   { name, path, writable }
 *   POST   /api/sessions/:id/workspaces/temporary               { name }: a folder the app makes
 *   GET    /api/workspaces/:id
 *   PUT    /api/workspaces/:id                                  { name, path, writable }
 *   DELETE /api/workspaces/:id                                  to the trash; a temporary one and its folder are deleted
 *   POST   /api/workspaces/:id/restore
 *   GET    /api/workspace-grants                                "Always allow" per tool
 *   DELETE /api/workspace-grants                                { tool, workspaceId }
 *   GET    /api/fs/dirs?path=                                   folders, for the folder picker
 *   GET    /api/workspaces/:id/tree?path=                       one folder of the tree, with what is searched
 *   GET    /api/workspaces/:id/files                            every file and folder, shallowest first (capped), for the Files tree
 *   GET    /api/workspaces/:id/file?path=                       the start of a file, for the Files tree
 *   GET    /api/workspaces/:id/file/raw?path=                   the bytes of an image or audio file
 *   GET    /api/workspaces/:id/index                            the ticks and the index's status
 *   PUT    /api/workspaces/:id/ticks                            { ticks }: what is searched
 *   POST   /api/workspaces/:id/ticks/toggle                     { path, on }
 *   POST   /api/workspaces/:id/rescan
 *
 * Every change is announced on the app-wide stream as `workspaces.changed`.
 */

const Content = z.object({
  name: z.string(),
  path: z.string(),
  writable: z.boolean(),
});
const IdParams = z.object({ id: z.string() });
const ListQuery = z.object({ deleted: z.enum(["true", "false"]).optional() });
const TempBody = z.object({ name: z.string() });
const FileQuery = z.object({ path: z.string() });
const GrantBody = z.object({ tool: z.string(), workspaceId: z.string() });
const DirsQuery = z.object({ path: z.string().optional() });
const TreeQuery = z.object({ path: z.string().default("") });
const TicksBody = z.object({ ticks: z.array(z.string()) });
const ToggleBody = z.object({ path: z.string(), on: z.boolean() });

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    workspaces: WorkspaceStore;
    events: AppEvents;
    indexer?: WorkspaceIndexer;
  },
) {
  const { store, workspaces, events, indexer } = deps;
  const announce = () =>
    events.publish({ type: "workspaces.changed", data: {} });

  /** The owner must exist. */
  const checkOwner = (owner: WorkspaceOwner) => {
    if (owner.scope === "project") {
      if (!store.getProject(owner.id)) {
        throw new WorkspaceStoreError("Project not found.", 404);
      }
    } else if (owner.scope === "session") {
      if (!store.getSession(owner.id)) {
        throw new WorkspaceStoreError("Session not found.", 404);
      }
    }
    return owner;
  };

  const scopes: [string, (req: { params: unknown }) => WorkspaceOwner][] = [
    ["/api/global/workspaces", () => ({ scope: "global" })],
    [
      "/api/projects/:id/workspaces",
      (req) => ({ scope: "project", id: IdParams.parse(req.params).id }),
    ],
    [
      "/api/sessions/:id/workspaces",
      (req) => ({ scope: "session", id: IdParams.parse(req.params).id }),
    ],
  ];
  for (const [path, ownerOf] of scopes) {
    app.get(path, async (req) =>
      workspaces.list(
        checkOwner(ownerOf(req)),
        ListQuery.parse(req.query).deleted === "true",
      ),
    );

    app.post(path, async (req, reply) => {
      const row = workspaces.create(
        checkOwner(ownerOf(req)),
        Content.parse(req.body),
      );
      announce();
      return reply.code(201).send(row);
    });
  }

  app.post("/api/sessions/:id/workspaces/temporary", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    checkOwner({ scope: "session", id });
    const row = workspaces.createTemporary(id, TempBody.parse(req.body).name);
    announce();
    return reply.code(201).send(row);
  });

  app.get("/api/workspaces/:id", async (req) => {
    const row = workspaces.get(IdParams.parse(req.params).id);
    if (!row) throw new WorkspaceStoreError("Workspace not found.", 404);
    return row;
  });

  app.put("/api/workspaces/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = workspaces.update(id, Content.parse(req.body));
    announce();
    // A new folder means the files are not the ones that were indexed.
    await indexer?.refresh(id);
    return row;
  });

  app.delete("/api/workspaces/:id", async (req) => {
    const id = IdParams.parse(req.params).id;
    const existing = workspaces.get(id);
    const row = existing?.temporary
      ? workspaces.destroyTemporary(id)
      : workspaces.trash(id);
    announce();
    await indexer?.refresh(row.id);
    return row;
  });

  app.post("/api/workspaces/:id/restore", async (req) => {
    const row = workspaces.restore(IdParams.parse(req.params).id);
    announce();
    await indexer?.refresh(row.id);
    return row;
  });

  // ---- What is searched (D45, D53) ----------------------------------------

  const live = (id: string) => {
    const w = workspaces.get(id);
    if (!w) throw new WorkspaceStoreError("Workspace not found.", 404);
    if (w.deleted) {
      throw new WorkspaceStoreError(
        "This workspace is in the trash. Restore it first.",
        409,
      );
    }
    return w;
  };

  /** The entries of a folder as paths, folders first, for the tree. */
  const filesOf = (root: string, folder: string) => {
    let abs: string;
    try {
      abs = resolveIn(root, folder);
    } catch (err) {
      throw new WorkspaceStoreError((err as Error).message, 400);
    }
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new WorkspaceStoreError(`There is no folder "${folder}".`, 404);
    }
    return readdirSync(abs)
      .map((name) => {
        const rel = folder === "" ? name : `${folder}/${name}`;
        try {
          const kind: "file" | "folder" = statSync(
            join(abs, name),
          ).isDirectory()
            ? "folder"
            : "file";
          return { name, path: rel, kind };
        } catch {
          return undefined; // a broken link
        }
      })
      .flatMap((e) => (e ? [e] : []))
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
          a.name.localeCompare(b.name),
      );
  };

  app.get("/api/workspaces/:id/tree", async (req) => {
    const w = live(IdParams.parse(req.params).id);
    const { path } = TreeQuery.parse(req.query);
    const folder = path.replace(/^\/+|\/+$/g, "");
    return {
      path: folder,
      entries: filesOf(w.path, folder).map((e) => ({
        ...e,
        state: tickState(w.ticks, e.path),
      })),
    };
  });

  app.get("/api/workspaces/:id/index", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const w = workspaces.get(id);
    if (!w) return reply.code(404).send({ error: "Workspace not found." });
    return {
      ticks: w.ticks,
      status: indexer?.status(id) ?? null,
    };
  });

  const saveTicks = async (id: string, ticks: string[]) => {
    const w = live(id);
    let clean: string[];
    try {
      clean = normalizeTicks(ticks);
      for (const t of clean) resolveIn(w.path, t);
    } catch (err) {
      throw new WorkspaceStoreError((err as Error).message, 400);
    }
    const row = workspaces.setTicks(id, clean);
    announce();
    await indexer?.refresh(id);
    return { ticks: row.ticks, status: indexer?.status(id) ?? null };
  };

  app.put("/api/workspaces/:id/ticks", async (req) =>
    saveTicks(IdParams.parse(req.params).id, TicksBody.parse(req.body).ticks),
  );

  app.post("/api/workspaces/:id/ticks/toggle", async (req) => {
    const { id } = IdParams.parse(req.params);
    const w = live(id);
    const { path, on } = ToggleBody.parse(req.body);
    let next: string[];
    try {
      next = toggleTick(w.ticks, path, on, (folder) =>
        filesOf(w.path, folder).map((e) => e.path),
      );
    } catch (err) {
      if (err instanceof WorkspaceStoreError) throw err;
      throw new WorkspaceStoreError((err as Error).message, 400);
    }
    return saveTicks(id, next);
  });

  app.post("/api/workspaces/:id/rescan", async (req) => {
    const { id } = IdParams.parse(req.params);
    live(id);
    return indexer ? ((await indexer.refresh(id)) ?? null) : null;
  });

  /** A path that leaves the folder or is not there is the caller's mistake. */
  const refused = (err: unknown): never => {
    if (err instanceof WorkspaceError) {
      throw new WorkspaceStoreError(
        err.message,
        err.code === "not_found" ? 404 : 400,
      );
    }
    throw err;
  };

  app.get("/api/workspaces/:id/files", async (req) => {
    const w = live(IdParams.parse(req.params).id);
    if (!existsSync(w.path)) {
      return { entries: [], truncated: false, unavailable: true };
    }
    return { ...walkWorkspace(w.path), unavailable: false };
  });

  app.get("/api/workspaces/:id/file", async (req) => {
    const w = live(IdParams.parse(req.params).id);
    const { path } = FileQuery.parse(req.query);
    try {
      return previewFile(w.path, path);
    } catch (err) {
      return refused(err);
    }
  });

  app.get("/api/workspaces/:id/file/raw", async (req, reply) => {
    const w = live(IdParams.parse(req.params).id);
    const { path } = FileQuery.parse(req.query);
    let found: ReturnType<ReturnType<typeof workspaceMediaSource>>;
    try {
      found = workspaceMediaSource(() => [w])(w.id, path);
    } catch (err) {
      return refused(err);
    }
    const data = found?.bytes();
    if (!found || !data) {
      return reply.code(404).send({ error: "File not found." });
    }
    return reply
      .header("content-type", found.mediaType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(data);
  });

  app.get("/api/workspace-grants", async () =>
    workspaces.grantsFor("workspace").map((g) => ({
      tool: g.tool,
      workspaceId: g.subjectId,
      workspaceName: workspaces.get(g.subjectId)?.name ?? null,
    })),
  );

  app.delete("/api/workspace-grants", async (req) => {
    const body = GrantBody.parse(req.body);
    if (!workspaces.revokeSubject(body.tool, "workspace", body.workspaceId)) {
      throw new WorkspaceStoreError("There is no such grant.", 404);
    }
    announce();
    return { ok: true };
  });

  // The backend runs on the user's own computer; the picker shows its folders.
  app.get("/api/fs/dirs", async (req) => {
    const given = DirsQuery.parse(req.query).path;
    const path = resolve(given && given !== "" ? given : homedir());
    if (!isAbsolute(path)) {
      throw new WorkspaceStoreError("The path must be a full path.", 400);
    }
    let names: string[];
    try {
      if (!statSync(path).isDirectory()) throw new Error("not a folder");
      names = readdirSync(path);
    } catch {
      throw new WorkspaceStoreError(`Cannot open ${path}.`, 400);
    }
    const dirs = names
      .filter((n) => {
        try {
          return statSync(join(path, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
    return {
      path,
      parent: dirname(path) === path ? null : dirname(path),
      dirs,
    };
  });
}
