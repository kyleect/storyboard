import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApprovalChoice,
  getReasoningLevels,
  listLlamaServerModels,
  loadLlamaServerModel,
  type LoadResult,
  type ModelInfo,
  type ReasoningLevels,
  type StoredEvent,
} from "@harness/core";
import { RunError, type RunManager } from "./runs.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Store } from "./store.js";
import { listToolSettings, setToolAsks } from "./tool-settings.js";

/*
 * HTTP routes (design doc 6.10, 6.14). Routes are thin adapters over the
 * run manager and store. Every /api route needs the token, sent as
 * `Authorization: Bearer <token>` or, for the event stream (EventSource
 * cannot set headers), as `?token=`. Query strings are never logged.
 */

export interface ServerOptions {
  store: Store;
  runs: RunManager;
  token: string;
  /** Idle time before a keepalive comment is sent on an event stream. */
  keepaliveMs?: number;
  logger?: boolean;
  newId?: () => string;
  now?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to asking the configured llama-server. */
  listModels?: () => Promise<ModelInfo[]>;
  /** Defaults to asking the configured llama-server. */
  loadModel?: (model: string) => Promise<LoadResult>;
  /** Defaults to asking the configured llama-server. */
  reasoningLevels?: (model: string | undefined) => Promise<ReasoningLevels>;
}

const IdParams = z.object({ id: z.string() });
/** Trimmed; empty is rejected; no maximum (design Q2). */
const Title = z.string().trim().min(1);
const ModelName = z.string().min(1);
/** "none" turns reasoning off; other values go to the chat template. */
const Effort = z.string().min(1);
const Choices = z.object({
  model: ModelName.optional(),
  reasoningEffort: Effort.optional(),
});

/** Drops undefined fields (exactOptionalPropertyTypes). */
function defined<T extends object>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store, runs } = options;
  const keepaliveMs = options.keepaliveMs ?? 10_000;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const env = options.env ?? process.env;
  const expected = Buffer.from(options.token);
  const llamaUrl = () => readSettings(store.db, env).effective.llamaServerUrl;
  const reasoningLevels =
    options.reasoningLevels ??
    ((model: string | undefined) => getReasoningLevels(llamaUrl(), model));
  const loadModel =
    options.loadModel ??
    ((model: string) => loadLlamaServerModel(llamaUrl(), model));
  const listModels =
    options.listModels ?? (() => listLlamaServerModels(llamaUrl()));

  const app = Fastify({
    // Event streams never end on their own; close them on shutdown.
    forceCloseConnections: true,
    logger: options.logger
      ? {
          serializers: {
            // The path only: the query string can hold the token.
            req: (req: FastifyRequest) => ({
              method: req.method,
              url: req.url.split("?")[0] ?? "",
            }),
          },
        }
      : false,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const header = req.headers.authorization;
    const fromHeader = header?.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;
    const fromQuery = (req.query as { token?: string } | undefined)?.token;
    const given = Buffer.from(fromHeader ?? fromQuery ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RunError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: "Invalid request", issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: (err as Error).message });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/settings", async () => readSettings(store.db, env));

  app.put("/api/settings", async (req) => {
    writeSettings(store.db, req.body);
    return readSettings(store.db, env);
  });

  /** The models llama-server offers, for the model picker. */
  app.get("/api/models", async (_req, reply) => {
    try {
      return await listModels();
    } catch (err) {
      return reply.code(502).send({
        error: `Could not list models from llama-server: ${(err as Error).message}`,
      });
    }
  });

  app.get("/api/sessions", async () => store.listSessions());

  app.post("/api/sessions", async (req, reply) => {
    const body = z.object({ title: Title.optional() }).parse(req.body ?? {});
    const session = store.createSession(
      newId(),
      body.title ?? "New session",
      now(),
    );
    return reply.code(201).send(session);
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    return {
      session,
      messages: store.listMessages(id),
      ...runs.snapshot(id),
    };
  });

  /**
   * Asks the router to load a model. Loading continues in the background;
   * GET /api/models shows its status. 502 when llama-server cannot be
   * reached or fails.
   */
  app.post("/api/models/load", async (req, reply) => {
    const { model } = z.object({ model: ModelName }).parse(req.body);
    try {
      return await loadModel(model);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * The reasoning effort levels a model's chat template supports, read
   * without loading the model: `{ levels }`, or `{ unavailable }` with
   * llama-server's reason (for example, the model is not loaded). 502 when
   * llama-server cannot be reached or fails.
   */
  app.get("/api/models/reasoning-levels", async (req, reply) => {
    const { model } = z
      .object({ model: ModelName.optional() })
      .parse(req.query);
    try {
      return await reasoningLevels(model);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Renames the session or changes its choices. A field left out is
   * unchanged; null returns a choice to the default from Settings. Refused
   * for a session in the trash.
   */
  app.patch("/api/sessions/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { title, ...choices } = z
      .object({
        title: Title.optional(),
        model: ModelName.nullable().optional(),
        reasoningEffort: Effort.nullable().optional(),
      })
      .refine(
        (c) =>
          c.title !== undefined ||
          c.model !== undefined ||
          c.reasoningEffort !== undefined,
        { message: "Nothing to change" },
      )
      .parse(req.body);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    if (session.trashed_at !== null)
      return reply.code(409).send({ error: "The session is in the trash." });
    if (title !== undefined) store.renameSession(id, title);
    store.setSessionChoices(id, defined(choices));
    return store.getSession(id);
  });

  /** Moves the session to the trash. 409 while a run is in progress. */
  app.post("/api/sessions/:id/trash", async (req) => {
    const { id } = IdParams.parse(req.params);
    runs.trashSession(id);
    return store.getSession(id);
  });

  /** Takes the session out of the trash. */
  app.post("/api/sessions/:id/restore", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    if (session.trashed_at === null)
      return reply
        .code(409)
        .send({ error: "The session is not in the trash." });
    store.setSessionTrashed(id, null);
    return store.getSession(id);
  });

  /** Permanently deletes a session. Only a session in the trash. */
  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    if (session.trashed_at === null)
      return reply
        .code(409)
        .send({ error: "Only a session in the trash can be deleted." });
    store.purgeSession(id);
    return { ok: true };
  });

  /** Everything in the trash. */
  app.get("/api/trash", async () => ({
    sessions: store.listTrashedSessions(),
  }));

  /** Empties the trash: permanently deletes everything in it. */
  app.delete("/api/trash", async () => ({
    purged: store.purgeTrashedSessions().length,
  }));

  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { content, ...choices } = Choices.extend({
      content: z.string().min(1),
    }).parse(req.body);
    return reply
      .code(202)
      .send(runs.sendMessage(id, content, defined(choices)));
  });

  app.post("/api/sessions/:id/continue", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const choices = Choices.parse(req.body ?? {});
    return reply.code(202).send(runs.continueLast(id, defined(choices)));
  });

  /** Asks the model to stop reasoning and answer. */
  app.post("/api/runs/:id/end-reasoning", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found." });
    return runs.endReasoning(id);
  });

  /**
   * Answers an approval request: once, session, always or deny
   * (tools design 6.5). 409 when the run is not active, 404 when the request
   * is not open.
   */
  app.post("/api/runs/:id/approvals/:requestId", async (req, reply) => {
    const { id, requestId } = IdParams.extend({
      requestId: z.string(),
    }).parse(req.params);
    const { choice } = z.object({ choice: ApprovalChoice }).parse(req.body);
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found." });
    runs.answerApproval(id, requestId, choice);
    return { ok: true };
  });

  /** Every tool, with its approval default and whether it asks now. */
  app.get("/api/tools", async () => listToolSettings(store.db, runs.tools));

  /** Sets whether a tool asks before running (either way, 6.5). */
  app.put("/api/tools/:name/approval", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const { ask } = z.object({ ask: z.boolean() }).parse(req.body);
    const tool = runs.tools.find((t) => t.name === name);
    if (!tool) return reply.code(404).send({ error: "Tool not found." });
    setToolAsks(store.db, tool, ask);
    return listToolSettings(store.db, [tool])[0];
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found." });
    return { cancelled: runs.cancel(id) };
  });

  /*
   * Server-sent events for one session. Sends stored events after
   * `Last-Event-ID` (header, or `lastEventId` query for the first connect),
   * then live events. Sends a keepalive comment after `keepaliveMs` idle.
   */
  app.get("/api/sessions/:id/events", (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!store.getSession(id)) {
      void reply.code(404).send({ error: "Session not found." });
      return;
    }
    const q = req.query as { lastEventId?: string };
    const header = req.headers["last-event-id"];
    const after = Number(
      (Array.isArray(header) ? header[0] : header) ?? q.lastEventId ?? 0,
    );

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        res.write(": keepalive\n\n");
        arm();
      }, keepaliveMs);
    };
    const send = (event: StoredEvent) => {
      const { id: eventId, ...rest } = event;
      res.write(`id: ${eventId}\ndata: ${JSON.stringify(rest)}\n\n`);
      arm();
    };

    // Replay and subscribe in the same tick, so no event falls in between.
    const backlog = store.eventsAfter(id, Number.isFinite(after) ? after : 0);
    const unsubscribe = runs.subscribe(id, send);
    res.write(": connected\n\n");
    for (const event of backlog) send(event);
    arm();

    req.raw.on("close", () => {
      clearTimeout(timer);
      unsubscribe();
    });
  });

  return app;
}
