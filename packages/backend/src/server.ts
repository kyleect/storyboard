import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { StoredEvent } from "@harness/core";
import { RunError, type RunManager } from "./runs.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Store } from "./store.js";

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
}

const IdParams = z.object({ id: z.string() });

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store, runs } = options;
  const keepaliveMs = options.keepaliveMs ?? 10_000;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const env = options.env ?? process.env;
  const expected = Buffer.from(options.token);

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

  app.get("/api/sessions", async () => store.listSessions());

  app.post("/api/sessions", async (req, reply) => {
    const body = z
      .object({ title: z.string().min(1).optional() })
      .parse(req.body ?? {});
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

  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { content } = z
      .object({ content: z.string().min(1) })
      .parse(req.body);
    return reply.code(202).send(runs.sendMessage(id, content));
  });

  app.post("/api/sessions/:id/continue", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    return reply.code(202).send(runs.continueLast(id));
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
