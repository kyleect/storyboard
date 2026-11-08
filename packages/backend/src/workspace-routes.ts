import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppEvents } from "./app-events.js";
import type { Store } from "./store.js";
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

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { store: Store; workspaces: WorkspaceStore; events: AppEvents },
) {
  const { store, workspaces, events } = deps;
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
    return row;
  });

  app.delete("/api/workspaces/:id", async (req) => {
    const row = workspaces.trash(IdParams.parse(req.params).id);
    announce();
    return row;
  });

  app.post("/api/workspaces/:id/restore", async (req) => {
    const row = workspaces.restore(IdParams.parse(req.params).id);
    announce();
    return row;
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
