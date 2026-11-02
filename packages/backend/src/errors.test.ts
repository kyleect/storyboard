import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  ToolError,
  ToolRunError,
  type ScriptStep,
  type Tool,
} from "@harness/core";
import type { AppEvent } from "./app-events.js";
import type { ErrorEntry, ErrorFilterOptions } from "./errors-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Recording, listing and clearing errors (error reporting plan, P4-P6). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** Throws a ToolError with details. */
const fetcher = defineTool({
  name: "fetcher",
  description: "Fails to fetch.",
  input: z.object({ url: z.string() }),
  approval: "never",
  execute: ({ url }) => {
    throw new ToolError(`HTTP 404 fetching ${url}`, {
      details: { url, status: 404 },
    });
  },
});

/** Ends the run. */
const stopper = defineTool({
  name: "stopper",
  description: "Ends the run.",
  input: z.object({}),
  approval: "never",
  execute: () => {
    throw new ToolRunError("cannot go on", { details: { why: "x" } });
  },
});

/** Asks before running, so it can be denied. */
const asker = defineTool({
  name: "asker",
  description: "Asks first.",
  input: z.object({}),
  approval: "ask",
  execute: () => ({ data: "ran" }),
});

const TOOLS: Tool[] = [fetcher, stopper, asker];

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

async function setup(scripts: ScriptStep[][]) {
  const t = tempDatabase();
  const store = new Store(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: TOOLS,
    now,
  });
  const app = buildServer({ store, runs, token: TOKEN, env: {}, now });
  const events: AppEvent[] = [];
  runs.events.subscribe((e) => events.push(e));
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, events };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

async function newSession(app: FastifyInstance, projectId?: string) {
  const { body } = await api(app, "POST", "/api/sessions", {
    ...(projectId ? { projectId } : {}),
  });
  return (body as { id: string }).id;
}

async function newProject(app: FastifyInstance, name: string) {
  const { body } = await api(app, "POST", "/api/projects", { name });
  return (body as { id: string }).id;
}

/** Sends a message and waits for its run to end. */
async function send(app: FastifyInstance, runs: RunManager, id: string) {
  const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
    content: "Hi",
  });
  const runId = (body as { runId: string }).runId;
  await expect.poll(() => runs.isActive(runId)).toBe(false);
  return runId;
}

const list = async (app: FastifyInstance, query = "") =>
  (await api(app, "GET", `/api/errors${query}`)).body as ErrorEntry[];

const call = (
  callId: string,
  name: string,
  args: unknown = {},
): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const answer: ScriptStep[] = [{ type: "text", text: "Done" }];

describe("recording errors", () => {
  it("records a tool error with its details, stack and arguments", async () => {
    const { app, runs, events } = await setup([
      [call("c1", "fetcher", { url: "https://x.test" })],
      answer,
    ]);
    const s = await newSession(app);
    const runId = await send(app, runs, s);

    const errors = await list(app);
    expect(errors).toHaveLength(1);
    const detail = (await api(app, "GET", `/api/sessions/${s}`)).body as {
      messages: { id: string; message: { role: string; content: string } }[];
    };
    const result = detail.messages.find((m) => m.message.role === "tool");
    expect(errors[0]).toEqual({
      id: expect.any(String) as unknown,
      sessionId: s,
      sessionTitle: "New session",
      projectId: null,
      projectName: null,
      runId,
      messageId: result?.id,
      callId: "c1",
      source: "tool",
      kind: "tool_threw",
      toolName: "fetcher",
      message: "fetcher failed: HTTP 404 fetching https://x.test",
      details: { url: "https://x.test", status: 404 },
      stack: expect.stringContaining("HTTP 404") as unknown,
      arguments: { url: "https://x.test" },
      createdAt: expect.any(String) as unknown,
    });
    // The model got the message, not the details.
    expect(result?.message.content).toBe(
      "fetcher failed: HTTP 404 fetching https://x.test",
    );
    expect(events).toEqual([
      { type: "errors.changed", data: { sessionId: s } },
    ]);
  });

  it("records the model's mistakes but not a denied call", async () => {
    const { app, runs } = await setup([
      [
        call("c1", "nope"),
        call("c2", "fetcher", "{bad"),
        call("c3", "fetcher", { url: 5 }),
        call("c4", "asker"),
      ],
      answer,
    ]);
    const s = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
    });
    const runId = (body as { runId: string }).runId;
    // Deny the asker call.
    await expect
      .poll(
        async () =>
          (
            (await api(app, "GET", `/api/sessions/${s}`)).body as {
              activeRun: { approvals: { requestId: string }[] } | null;
            }
          ).activeRun?.approvals.length,
      )
      .toBe(1);
    const open = (
      (await api(app, "GET", `/api/sessions/${s}`)).body as {
        activeRun: { approvals: { requestId: string }[] };
      }
    ).activeRun.approvals[0];
    await api(app, "POST", `/api/runs/${runId}/approvals/${open?.requestId}`, {
      choice: "deny",
    });
    await expect.poll(() => runs.isActive(runId)).toBe(false);

    const errors = await list(app);
    expect(
      errors.map((e) => [e.kind, e.callId, e.toolName, e.arguments]).reverse(),
    ).toEqual([
      ["unknown_tool", "c1", "nope", {}],
      ["malformed_call", "c2", "fetcher", "{bad"],
      ["invalid_arguments", "c3", "fetcher", { url: 5 }],
    ]);
  });

  it("records a failed run", async () => {
    const { app, runs, events } = await setup([
      [{ type: "throw", message: "llama-server: connection refused" }],
    ]);
    const s = await newSession(app);
    const runId = await send(app, runs, s);
    const errors = await list(app);
    expect(errors).toEqual([
      expect.objectContaining({
        runId,
        source: "run",
        kind: "run_failed",
        toolName: null,
        callId: null,
        messageId: null,
        message: expect.stringContaining(
          "llama-server: connection refused",
        ) as unknown,
        details: null,
        stack: null,
        arguments: null,
      }),
    ]);
    expect(events).toEqual([
      { type: "errors.changed", data: { sessionId: s } },
    ]);
  });

  it("records a run ended by a tool once, as the tool error (O4)", async () => {
    const { app, runs, store } = await setup([[call("c1", "stopper")]]);
    const s = await newSession(app);
    const runId = await send(app, runs, s);
    expect(store.getRun(runId)?.status).toBe("failed");
    const errors = await list(app);
    expect(errors).toEqual([
      expect.objectContaining({
        source: "tool",
        kind: "tool_threw",
        toolName: "stopper",
        message: "cannot go on",
        details: { why: "x" },
      }),
    ]);
  });

  it("records an unexpected failure with its stack", async () => {
    const { app, runs, store } = await setup([[call("c1", "fetcher", {})]]);
    store.linkRunMessage = () => {
      throw new Error("disk full");
    };
    const s = await newSession(app);
    await send(app, runs, s);
    const errors = await list(app);
    expect(errors).toEqual([
      expect.objectContaining({
        source: "run",
        kind: "run_failed",
        message: "disk full",
        stack: expect.stringContaining("disk full") as unknown,
      }),
    ]);
  });
});

describe("listing, filtering and clearing", () => {
  /**
   * Session a (standalone): a tool error. Session b (project P): a tool
   * error and a failed run.
   */
  async function seeded() {
    const ctx = await setup([
      [call("c1", "fetcher", { url: "a" })],
      answer,
      [call("c2", "fetcher", { url: "b" })],
      answer,
      [{ type: "throw", message: "boom" }],
    ]);
    const { app, runs } = ctx;
    const a = await newSession(app);
    await send(app, runs, a);
    const p = await newProject(app, "P");
    const b = await newSession(app, p);
    await send(app, runs, b);
    await send(app, runs, b);
    ctx.events.length = 0;
    return { ...ctx, a, b, p };
  }

  it("lists newest first and filters by session, project, source and tool", async () => {
    const { app, a, b, p } = await seeded();
    const all = await list(app);
    expect(all.map((e) => [e.sessionId, e.source])).toEqual([
      [b, "run"],
      [b, "tool"],
      [a, "tool"],
    ]);
    expect(all[0]).toMatchObject({ projectId: p, projectName: "P" });

    expect(
      (await list(app, `?sessionId=${a}`)).map((e) => e.sessionId),
    ).toEqual([a]);
    expect(
      (await list(app, `?projectId=${p}`)).map((e) => e.sessionId),
    ).toEqual([b, b]);
    expect(
      (await list(app, "?projectId=none")).map((e) => e.sessionId),
    ).toEqual([a]);
    expect((await list(app, "?source=run")).map((e) => e.kind)).toEqual([
      "run_failed",
    ]);
    expect(
      (await list(app, `?source=tool&projectId=${p}`)).map((e) => e.callId),
    ).toEqual(["c2"]);
    expect((await list(app, "?tool=fetcher")).length).toBe(2);
    expect((await api(app, "GET", "/api/errors?source=bad")).status).toBe(400);

    expect((await api(app, "GET", "/api/errors/filters")).body).toEqual({
      sessions: [
        { id: a, title: "New session", projectId: null },
        { id: b, title: "New session", projectId: p },
      ].sort((x, y) => x.id.localeCompare(y.id)),
      projects: [{ id: p, name: "P" }],
      tools: ["fetcher"],
      runs: true,
    } satisfies ErrorFilterOptions);
  });

  it("hides errors of sessions in the trash, and deletes them with the session", async () => {
    const { app, a, b, t } = await seeded();
    await api(app, "POST", `/api/sessions/${a}/trash`);
    expect((await list(app)).map((e) => e.sessionId)).toEqual([b, b]);
    expect(
      (
        (await api(app, "GET", "/api/errors/filters"))
          .body as ErrorFilterOptions
      ).sessions.map((s) => s.id),
    ).toEqual([b]);

    // A global Clear keeps the hidden errors; they come back on restore.
    await api(app, "DELETE", "/api/errors");
    expect(await list(app)).toEqual([]);
    await api(app, "POST", `/api/sessions/${a}/restore`);
    expect((await list(app)).map((e) => e.sessionId)).toEqual([a]);

    await api(app, "POST", `/api/sessions/${a}/trash`);
    await api(app, "DELETE", `/api/sessions/${a}`);
    expect(t.db.prepare("SELECT count(*) AS n FROM errors").get()).toEqual({
      n: 0,
    });
  });

  it("clears one session's errors, or all of them", async () => {
    const { app, a, b, events } = await seeded();
    expect(
      (await api(app, "DELETE", `/api/errors?sessionId=${b}`)).body,
    ).toEqual({ cleared: 2 });
    expect((await list(app)).map((e) => e.sessionId)).toEqual([a]);
    expect((await api(app, "DELETE", "/api/errors")).body).toEqual({
      cleared: 1,
    });
    expect(await list(app)).toEqual([]);
    expect(events).toEqual([
      { type: "errors.changed", data: { sessionId: b } },
      { type: "errors.changed", data: { sessionId: null } },
    ]);
    expect(
      (await api(app, "DELETE", "/api/errors?sessionId=missing")).status,
    ).toBe(404);
  });
});

describe("the app-wide stream", () => {
  it("sends errors.changed", async () => {
    const { app, runs } = await setup([[call("c1", "fetcher", {})], answer]);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?token=${TOKEN}`, {
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(/: connected/);
    const s = await newSession(app);
    await send(app, runs, s);
    await readUntil(/errors\.changed/);
    expect(text).toContain(
      JSON.stringify({ type: "errors.changed", data: { sessionId: s } }),
    );
    controller.abort();
  });
});
