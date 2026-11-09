import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppEvents } from "./app-events.js";
import type { Store } from "./store.js";
import { resolveIn } from "./workspace-fs.js";
import type { WorkspaceIndexer } from "./workspace-index.js";
import { normalizeTicks, tickState, toggleTick } from "./workspace-ticks.js";
import {
  WorkspaceStoreError,
  type OwnerKind,
  type WorkspaceStore,
} from "./workspaces-store.js";

/*
 * Routes for workspaces (files unification design, D22 to D26, D46):
 *
 *   GET    /api/workspaces                       ?deleted=true: the trash
 *   POST   /api/workspaces                       { name, path, writable }
 *   PUT    /api/workspaces/:id
 *   DELETE /api/workspaces/:id                   to the trash; the folder stays
 *   POST   /api/workspaces/:id/restore
 *   GET    /api/projects/:id/workspaces          what the project has attached
 *   GET    /api/sessions/:id/workspaces          its own and its project's
 *   PUT    /api/{projects|sessions}/:id/workspaces/:workspaceId   { readOnly }
 *   DELETE /api/{projects|sessions}/:id/workspaces/:workspaceId
 *   GET    /api/workspace-grants                 "Always allow" per tool
 *   DELETE /api/workspace-grants                 { tool, workspaceId }
 *   GET    /api/fs/dirs?path=                    folders, for the folder picker
 *   GET    /api/workspaces/:id/tree?path=        one folder of the tree, with what is searched
 *   GET    /api/workspaces/:id/index             the ticks and the index's status
 *   PUT    /api/workspaces/:id/ticks             { ticks }: what is searched
 *   POST   /api/workspaces/:id/ticks/toggle      { path, on }
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
const AttachParams = z.object({ id: z.string(), workspaceId: z.string() });
const ListQuery = z.object({ deleted: z.enum(["true", "false"]).optional() });
const AttachBody = z.object({ readOnly: z.boolean().default(false) });
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

  app.get("/api/workspaces", async (req) =>
    workspaces.list(ListQuery.parse(req.query).deleted === "true"),
  );

  app.post("/api/workspaces", async (req, reply) => {
    const row = workspaces.create(Content.parse(req.body));
    announce();
    return reply.code(201).send(row);
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
    const row = workspaces.trash(IdParams.parse(req.params).id);
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
  const entriesOf = (root: string, folder: string) => {
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
      entries: entriesOf(w.path, folder).map((e) => ({
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
        entriesOf(w.path, folder).map((e) => e.path),
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

  /** The owner must exist; a project in the trash cannot be changed. */
  const checkOwner = (kind: OwnerKind, id: string) => {
    if (kind === "project") {
      if (!store.getProject(id)) {
        throw new WorkspaceStoreError("Project not found.", 404);
      }
    } else if (!store.getSession(id)) {
      throw new WorkspaceStoreError("Session not found.", 404);
    }
  };

  const view = (
    workspaceId: string,
    from: "project" | "session",
    readOnly: boolean,
    effective: Map<string, boolean>,
  ) => {
    const w = workspaces.get(workspaceId);
    return w
      ? {
          workspace: w,
          from,
          readOnly,
          effectiveWritable: !w.deleted && (effective.get(w.id) ?? false),
        }
      : undefined;
  };

  for (const [segment, kind] of [
    ["projects", "project"],
    ["sessions", "session"],
  ] as const) {
    app.get(`/api/${segment}/:id/workspaces`, async (req) => {
      const { id } = IdParams.parse(req.params);
      checkOwner(kind, id);
      const projectId =
        kind === "project" ? id : (store.getSession(id)?.project_id ?? null);
      const effective = new Map(
        workspaces
          .forSession(kind === "session" ? id : "", projectId)
          .map((w) => [w.id, w.effectiveWritable]),
      );
      const own = workspaces.attachments(kind, id).map((a) => ({
        ...a,
        from: kind,
      }));
      const inherited =
        kind === "session" && projectId
          ? workspaces
              .attachments("project", projectId)
              .map((a) => ({ ...a, from: "project" as const }))
          : [];
      return [...inherited, ...own].flatMap((a) => {
        const v = view(a.workspaceId, a.from, a.readOnly, effective);
        return v ? [v] : [];
      });
    });

    app.put(`/api/${segment}/:id/workspaces/:workspaceId`, async (req) => {
      const { id, workspaceId } = AttachParams.parse(req.params);
      checkOwner(kind, id);
      workspaces.attach(
        kind,
        id,
        workspaceId,
        AttachBody.parse(req.body ?? {}).readOnly,
      );
      announce();
      return { ok: true };
    });

    app.delete(`/api/${segment}/:id/workspaces/:workspaceId`, async (req) => {
      const { id, workspaceId } = AttachParams.parse(req.params);
      checkOwner(kind, id);
      if (!workspaces.detach(kind, id, workspaceId)) {
        throw new WorkspaceStoreError("That workspace is not attached.", 404);
      }
      announce();
      return { ok: true };
    });
  }

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
