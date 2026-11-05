import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createDataAccess,
  DataError,
  messageDataOps,
  replaySessionData,
  type DataAgent,
  type DataOp,
  type DataScope,
  type SchemaChecker,
} from "@harness/core";
import type { AgentStore } from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import type { DataStore } from "./data-store.js";
import type { RunManager } from "./runs.js";
import type { Store } from "./store.js";

/*
 * Routes for data in the app (schemas and data design, decisions 19 to 25,
 * 44). One set per scope:
 *
 *   /api/global/data
 *   /api/projects/:projectId/data
 *   /api/agents/:agentId/data
 *   /api/sessions/:sessionId/data
 *
 *   GET    {base}                ?deleted=true includes deleted data
 *   GET    {base}/schemas        schemas whose data can be made here
 *   GET    {base}/schemas/:id    one, with its latest JSON Schema
 *   POST   {base}                create { schemaId, name, description, value }
 *   GET    {base}/:dataId        with its schema versions and its history
 *   PUT    {base}/:dataId        save { name, description, value }
 *   POST   {base}/:dataId/migrate  { value }: to the latest schema version
 *   DELETE {base}/:dataId        soft delete
 *   POST   {base}/:dataId/restore  { seq }: make a saved state current
 *
 * Writes go through the same checks as the data tools, by the user. Session
 * data is recorded as edit messages and can't change during a run (plan P4).
 * Data of a project in the trash, of a deleted agent and of a session in
 * the trash is read-only.
 */

const ListQuery = z.object({ deleted: z.enum(["true", "false"]).optional() });
const DataParams = z.object({ dataId: z.string() });
const Text = z.string().max(10_000);
const CreateBody = z.object({
  schemaId: z.string(),
  name: Text,
  description: Text,
  value: z.unknown(),
});
const SaveBody = z.object({
  name: Text,
  description: Text,
  value: z.unknown(),
});
const MigrateBody = z.object({ value: z.unknown() });
const RestoreBody = z.object({ seq: z.number().int().min(1) });

/** A refused request; mapped to its status by the error handler. */
class DataRouteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DataRouteError";
  }
}

interface Owner {
  scope: Exclude<DataScope, "session"> | "session";
  projectId: string | null;
  agent: DataAgent | null;
  sessionId: string | null;
  /** Why it can't be changed, when it can't. */
  readOnly: string | null;
}

/** A saved state, for the history (decision 24). */
interface HistoryEntry {
  seq: number;
  schemaVersion: number;
  name: string;
  description: string;
  value: unknown;
  deleted: boolean;
  author: "user" | "model";
  createdAt: string | null;
}

export function registerDataRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    runs: RunManager;
    agents: AgentStore;
    data: DataStore;
    checker: SchemaChecker;
    events: AppEvents;
  },
) {
  const { store, runs, agents, data, checker, events } = deps;

  const agentOf = (agentId: string | null): DataAgent | null => {
    if (agentId === null) return null;
    const a = agents.get(agentId);
    return a && !a.deleted ? { id: a.id, projectId: a.projectId } : null;
  };

  const globalOwner = (): Owner => ({
    scope: "global",
    projectId: null,
    agent: null,
    sessionId: null,
    readOnly: null,
  });
  const projectOwner = (projectId: string): Owner => {
    const project = store.getProject(projectId);
    if (!project) throw new DataRouteError("Project not found.", 404);
    return {
      scope: "project",
      projectId,
      agent: null,
      sessionId: null,
      readOnly:
        project.trashed_at !== null ? "The project is in the trash." : null,
    };
  };
  const agentOwner = (agentId: string): Owner => {
    const a = agents.get(agentId);
    if (!a) throw new DataRouteError("Agent not found.", 404);
    const trashed =
      a.projectId !== null && store.getProject(a.projectId)?.trashed_at != null;
    return {
      scope: "agent",
      projectId: a.projectId,
      agent: { id: a.id, projectId: a.projectId },
      sessionId: null,
      readOnly: a.deleted
        ? "The agent is deleted."
        : trashed
          ? "The agent's project is in the trash."
          : null,
    };
  };
  const sessionOwner = (sessionId: string): Owner => {
    const session = store.getSession(sessionId);
    if (!session) throw new DataRouteError("Session not found.", 404);
    return {
      scope: "session",
      projectId: session.project_id,
      agent: agentOf(session.agent_id),
      sessionId,
      readOnly:
        session.trashed_at !== null ? "The session is in the trash." : null,
    };
  };
  const param = (req: FastifyRequest, name: string) =>
    z.object({ [name]: z.string() }).parse(req.params)[name] as string;

  /** Each scope's route prefix, and how a request names its owner. */
  const prefixes: [string, (req: FastifyRequest) => Owner][] = [
    ["/api/global", () => globalOwner()],
    [
      "/api/projects/:projectId",
      (req) => projectOwner(param(req, "projectId")),
    ],
    ["/api/agents/:agentId", (req) => agentOwner(param(req, "agentId"))],
    [
      "/api/sessions/:sessionId",
      (req) => sessionOwner(param(req, "sessionId")),
    ],
  ];
  const bases = prefixes.map(
    ([prefix, ownerOf]) => [`${prefix}/data`, ownerOf] as const,
  );

  /** The data access the user gets for an owner, as the tools do. */
  const accessFor = (owner: Owner) => {
    const ops: DataOp[] = [];
    const messages = owner.sessionId ? store.listMessages(owner.sessionId) : [];
    const times = owner.sessionId
      ? store.messageTimes(owner.sessionId)
      : new Map<string, string>();
    const access = createDataAccess({
      session: replaySessionData(messages.map((m) => m.message)),
      sessionOps: ops,
      shared: data.shared({
        projectId: owner.projectId,
        agentId: owner.agent?.id ?? null,
      }),
      checker,
      projectId: owner.projectId,
      agent: owner.agent,
      author: { by: "user" },
    });
    return { access, ops, messages, times };
  };

  /** Runs a change, then records it (session) or announces it (the rest). */
  const write = <T>(
    owner: Owner,
    change: (a: ReturnType<typeof accessFor>) => T,
  ): T => {
    if (owner.readOnly) throw new DataRouteError(owner.readOnly, 409);
    const ctx = accessFor(owner);
    let result: T;
    try {
      result = change(ctx);
    } catch (err) {
      if (err instanceof DataError) {
        throw new DataRouteError(
          err.message,
          /^No (data|schema) with the id/.test(err.message) ? 404 : 400,
        );
      }
      throw err;
    }
    if (owner.sessionId) {
      if (ctx.ops.length > 0) runs.editSessionData(owner.sessionId, ctx.ops);
    } else {
      events.publish({ type: "data.changed", data: {} });
    }
    return result;
  };

  const read = <T>(
    owner: Owner,
    look: (a: ReturnType<typeof accessFor>) => T,
  ): T => {
    try {
      return look(accessFor(owner));
    } catch (err) {
      if (err instanceof DataError) {
        throw new DataRouteError(
          err.message,
          /^No (data|schema) with the id/.test(err.message) ? 404 : 400,
        );
      }
      throw err;
    }
  };

  /** A session's history of one piece of data, from its transcript. */
  const sessionHistory = (
    { messages, times }: ReturnType<typeof accessFor>,
    id: string,
  ): HistoryEntry[] => {
    const out: HistoryEntry[] = [];
    let last: HistoryEntry | undefined;
    for (const { id: messageId, message } of messages) {
      const createdAt = times.get(messageId) ?? null;
      for (const op of messageDataOps(message)) {
        if ((op.op === "data_put" || op.op === "data_delete") && op.id === id) {
          const by = message.role === "edit" ? "user" : "model";
          last =
            op.op === "data_put"
              ? {
                  seq: out.length + 1,
                  schemaVersion: op.schemaVersion,
                  name: op.name,
                  description: op.description,
                  value: op.value,
                  deleted: false,
                  author: by,
                  createdAt,
                }
              : last
                ? {
                    ...last,
                    seq: out.length + 1,
                    deleted: true,
                    author: by,
                    createdAt,
                  }
                : undefined;
          if (last) out.push(last);
        }
      }
    }
    return out;
  };

  const history = (
    owner: Owner,
    ctx: ReturnType<typeof accessFor>,
    id: string,
  ): HistoryEntry[] =>
    owner.sessionId
      ? sessionHistory(ctx, id)
      : data.versions(id).map((v) => ({
          seq: v.seq,
          schemaVersion: v.schemaVersion,
          name: v.name,
          description: v.description,
          value: v.value,
          deleted: v.deleted,
          author: v.author,
          createdAt: v.createdAt,
        }));

  for (const [base, ownerOf] of bases) {
    app.get(base, async (req) => {
      const owner = ownerOf(req);
      const q = ListQuery.parse(req.query);
      return read(owner, ({ access }) => ({
        readOnly: owner.readOnly,
        data: access.listData({
          scope: owner.scope,
          includeDeleted: q.deleted === "true",
        }),
      }));
    });

    app.get(`${base}/schemas`, async (req) => {
      const owner = ownerOf(req);
      return read(owner, ({ access }) =>
        access
          .listSchemas()
          .filter((s) => access.dataScopesFor(s.id).includes(owner.scope)),
      );
    });

    app.get(`${base}/schemas/:schemaId`, async (req) => {
      const owner = ownerOf(req);
      const { schemaId } = z.object({ schemaId: z.string() }).parse(req.params);
      return read(owner, ({ access }) => ({
        ...access.getSchema(schemaId),
        body: access.schemaBody(schemaId),
      }));
    });

    app.post(base, async (req, reply) => {
      const owner = ownerOf(req);
      const body = CreateBody.parse(req.body);
      const created = write(owner, ({ access }) =>
        access.createData({
          scope: owner.scope,
          schemaId: body.schemaId,
          name: body.name,
          description: body.description,
          value: body.value,
        }),
      );
      return reply.code(201).send(created);
    });

    app.get(`${base}/:dataId`, async (req) => {
      const owner = ownerOf(req);
      const { dataId } = DataParams.parse(req.params);
      return read(owner, (ctx) => {
        const view = ctx.access.getData(dataId, true);
        if (view.scope !== owner.scope) {
          throw new DataError(`No data with the id "${dataId}" here.`);
        }
        const schema = view.schemaInScope
          ? {
              ...ctx.access.getSchema(view.schemaId),
              pinned: ctx.access.schemaBody(view.schemaId, view.schemaVersion),
              latest: ctx.access.schemaBody(view.schemaId),
            }
          : null;
        return { ...view, schema, versions: history(owner, ctx, dataId) };
      });
    });

    app.put(`${base}/:dataId`, async (req) => {
      const owner = ownerOf(req);
      const { dataId } = DataParams.parse(req.params);
      const body = SaveBody.parse(req.body);
      return write(owner, ({ access }) =>
        access.updateData(dataId, {
          name: body.name,
          description: body.description,
          value: body.value,
        }),
      );
    });

    app.post(`${base}/:dataId/migrate`, async (req) => {
      const owner = ownerOf(req);
      const { dataId } = DataParams.parse(req.params);
      const { value } = MigrateBody.parse(req.body);
      return write(owner, ({ access }) => {
        const plan = access.planMigrate(dataId, undefined, undefined, value);
        return access.commitPlan(plan, plan.after);
      });
    });

    app.delete(`${base}/:dataId`, async (req, reply) => {
      const owner = ownerOf(req);
      const { dataId } = DataParams.parse(req.params);
      write(owner, ({ access }) => access.deleteData(dataId));
      return reply.code(204).send();
    });

    app.post(`${base}/:dataId/restore`, async (req) => {
      const owner = ownerOf(req);
      const { dataId } = DataParams.parse(req.params);
      const { seq } = RestoreBody.parse(req.body);
      return write(owner, (ctx) => {
        const version = history(owner, ctx, dataId).find((v) => v.seq === seq);
        if (!version)
          throw new DataError(
            `No data with the id "${dataId}" has version ${seq}.`,
          );
        if (version.deleted) {
          throw new DataError(
            "That version is a deletion; pick one before it.",
          );
        }
        return ctx.access.restoreData(dataId, version);
      });
    });
  }

  // ---- Schemas (decisions 8 to 15, 44; patch 4) ----------------------------

  const CopyTarget = z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("global") }),
    z.object({ scope: z.literal("project"), id: z.string() }),
    z.object({ scope: z.literal("agent"), id: z.string() }),
  ]);
  const SchemaBody = z.object({
    name: Text,
    description: Text,
    body: z.unknown(),
  });

  for (const [prefix, ownerOf] of prefixes) {
    const base = `${prefix}/schemas`;
    const SchemaParams = z.object({ schemaId: z.string() });
    /** The schema must be this owner's own (not one it only sees). */
    const own = (
      owner: Owner,
      access: ReturnType<typeof accessFor>["access"],
      id: string,
    ) => {
      const s = access.getSchema(id, true);
      const builtinHere = s.scope === "builtin" && owner.scope === "global";
      if (s.scope !== owner.scope && !builtinHere) {
        throw new DataError(`No schema with the id "${id}" here.`);
      }
      return s;
    };

    app.get(base, async (req) => {
      const owner = ownerOf(req);
      const q = ListQuery.parse(req.query);
      return read(owner, ({ access }) => ({
        readOnly: owner.readOnly,
        // The global page shows the built-in schemas too (decision 45).
        schemas: [
          ...(owner.scope === "global" ? access.listSchemas("builtin") : []),
          ...access.listSchemas(owner.scope, q.deleted === "true"),
        ],
      }));
    });

    app.post(base, async (req, reply) => {
      const owner = ownerOf(req);
      const body = SchemaBody.parse(req.body);
      const created = write(owner, ({ access }) =>
        access.createSchema({
          scope: owner.scope,
          name: body.name,
          description: body.description,
          body: body.body,
        }),
      );
      return reply.code(201).send(created);
    });

    app.get(`${base}/:schemaId`, async (req) => {
      const owner = ownerOf(req);
      const { schemaId } = SchemaParams.parse(req.params);
      return read(owner, ({ access }) => {
        const s = own(owner, access, schemaId);
        const versions = access.schemaVersions(schemaId);
        return {
          ...s,
          body: versions.at(-1)?.body,
          versions,
          // Hidden while the schema is deleted (decision 14).
          dataCount: s.deleted ? 0 : access.listData({ schemaId }).length,
        };
      });
    });

    app.put(`${base}/:schemaId`, async (req) => {
      const owner = ownerOf(req);
      const { schemaId } = SchemaParams.parse(req.params);
      const body = SchemaBody.parse(req.body);
      return write(owner, ({ access }) => {
        own(owner, access, schemaId);
        return access.updateSchema(schemaId, {
          name: body.name,
          description: body.description,
          body: body.body,
        });
      });
    });

    app.delete(`${base}/:schemaId`, async (req) => {
      const owner = ownerOf(req);
      const { schemaId } = SchemaParams.parse(req.params);
      return write(owner, ({ access }) => {
        own(owner, access, schemaId);
        return access.deleteSchema(schemaId);
      });
    });

    app.post(`${base}/:schemaId/restore`, async (req) => {
      const owner = ownerOf(req);
      const { schemaId } = SchemaParams.parse(req.params);
      return write(owner, ({ access }) => {
        own(owner, access, schemaId);
        return access.restoreSchema(schemaId);
      });
    });

    /** A copy of the latest version into another owner (decision 12). */
    app.post(`${base}/:schemaId/copy`, async (req, reply) => {
      const owner = ownerOf(req);
      const { schemaId } = SchemaParams.parse(req.params);
      const { to, name } = z
        .object({ to: CopyTarget, name: Text.optional() })
        .parse(req.body);
      const source = read(owner, ({ access }) => {
        const s = own(owner, access, schemaId);
        return { ...s, body: access.schemaBody(schemaId) };
      });
      const target =
        to.scope === "global"
          ? globalOwner()
          : to.scope === "project"
            ? projectOwner(to.id)
            : agentOwner(to.id);
      const copy = write(target, ({ access }) =>
        access.createSchema({
          scope: target.scope,
          name: name ?? source.name,
          description: source.description,
          body: source.body,
          copiedFrom: source.id,
        }),
      );
      return reply.code(201).send(copy);
    });
  }
}
