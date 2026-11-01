import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  LlamaServerAdapter,
  RunControl,
  ScriptedModel,
  type HarnessEvent,
  type ModelInfo,
  type ScriptStep,
} from "@harness/core";
import { chatChunk, FakeLlamaServer } from "@harness/core/testing";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS, readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(
  scripts: ScriptStep[][],
  keepaliveMs?: number,
  listModels?: () => Promise<ModelInfo[]>,
) {
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
  });
  const app = buildServer({
    store,
    runs,
    token: TOKEN,
    env: {},
    ...(keepaliveMs ? { keepaliveMs } : {}),
    ...(listModels ? { listModels } : {}),
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, base, model };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: auth,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown>,
  };
}

interface Received {
  id: number;
  event: HarnessEvent;
}

/** Opens the event stream and collects events until `until` is true. */
async function stream(
  base: string,
  sessionId: string,
  opts: {
    lastEventId?: number;
    until: (got: Received[], comments: string[]) => boolean;
    onEvent?: (e: Received) => void;
  },
) {
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined)
    headers["last-event-id"] = String(opts.lastEventId);
  const controller = new AbortController();
  const res = await fetch(
    `${base}/api/sessions/${sessionId}/events?token=${TOKEN}`,
    { headers, signal: controller.signal },
  );
  expect(res.status).toBe(200);
  const got: Received[] = [];
  const comments: string[] = [];
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!opts.until(got, comments)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) {
          comments.push(block.slice(1).trim());
          continue;
        }
        const id = Number(/^id: (\d+)$/m.exec(block)?.[1]);
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
        const r = { id, event: JSON.parse(data) as HarnessEvent };
        got.push(r);
        opts.onEvent?.(r);
      }
    }
  } finally {
    controller.abort();
  }
  return { got, comments };
}

const finished = (got: Received[]) =>
  got.some((r) =>
    ["run.finished", "run.failed", "run.interrupted"].includes(r.event.type),
  );

async function newSession(app: FastifyInstance) {
  const { body } = await api(app, "POST", "/api/sessions", { title: "Test" });
  return body.id as string;
}

async function waitIdle(runs: RunManager, runId: string) {
  await expect.poll(() => runs.isActive(runId)).toBe(false);
}

describe("auth", () => {
  it("rejects requests without the token", async () => {
    const { app } = await setup([]);
    expect((await app.inject({ url: "/api/sessions" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/sessions",
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: `/api/sessions?token=${TOKEN}` })).statusCode,
    ).toBe(200);
  });
});

describe("a chat turn", () => {
  it("streams the run's events with ids and saves the transcript", async () => {
    const { app, base, runs, model } = await setup([
      [
        { type: "text", text: "Hello" },
        { type: "text", text: " there" },
        { type: "usage", usage: { promptTokens: 3, completionTokens: 2 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);

    const listening = stream(base, id, { until: (got) => finished(got) });
    // Give the stream a moment to connect before starting.
    await new Promise((r) => setTimeout(r, 50));
    const sent = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    expect(sent.status).toBe(202);
    const { got } = await listening;

    expect(got.map((r) => r.event.type)).toEqual([
      "run.started",
      "step.started",
      "message.started",
      "text.delta",
      "text.delta",
      "text.end",
      "message.finished",
      "step.finished",
      "run.finished",
    ]);
    const ids = got.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    await waitIdle(runs, sent.body.runId as string);
    const session = await api(app, "GET", `/api/sessions/${id}`);
    expect(
      (session.body.messages as { message: unknown }[]).map((m) => m.message),
    ).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
    ]);
    // Events refer to the message under the id it is saved with.
    expect(got[2]?.event).toMatchObject({
      data: { messageId: (session.body.messages as { id: string }[])[1]?.id },
    });
    expect(session.body.activeRun).toBeNull();
    expect(session.body.lastEventId).toBe(ids.at(-1));
    expect(model.requests[0]).toEqual({
      kind: "chat",
      messages: [{ role: "user", content: "Hi" }],
      control: expect.any(RunControl),
      tools: [],
    });
  });

  it("stores each model call's usage on its message and lists the latest", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "One" },
        { type: "usage", usage: { promptTokens: 3, completionTokens: 2 } },
      ],
      [
        { type: "text", text: "Two" },
        { type: "usage", usage: { promptTokens: 9, completionTokens: 4 } },
      ],
    ]);
    const id = await newSession(app);
    const other = await newSession(app);

    const first = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, first.body.runId as string);
    const second = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Again",
    });
    await waitIdle(runs, second.body.runId as string);

    const session = await api(app, "GET", `/api/sessions/${id}`);
    expect(
      (session.body.messages as { usage: unknown }[]).map((m) => m.usage),
    ).toEqual([
      null,
      { promptTokens: 3, completionTokens: 2 },
      null,
      { promptTokens: 9, completionTokens: 4 },
    ]);

    const list = await api(app, "GET", "/api/sessions");
    const rows = list.body as unknown as { id: string; usage: unknown }[];
    expect(rows.find((r) => r.id === id)?.usage).toEqual({
      promptTokens: 9,
      completionTokens: 4,
    });
    expect(rows.find((r) => r.id === other)?.usage).toBeNull();
  });

  it("lists a project's sessions with their usage", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "One" },
        { type: "usage", usage: { promptTokens: 3, completionTokens: 2 } },
      ],
    ]);
    const project = await api(app, "POST", "/api/projects", { name: "P" });
    const created = await api(app, "POST", "/api/sessions", {
      projectId: project.body.id,
    });
    const id = created.body.id as string;
    const sent = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, sent.body.runId as string);

    const list = await api(
      app,
      "GET",
      `/api/sessions?projectId=${project.body.id as string}`,
    );
    expect(list.body).toEqual([
      expect.objectContaining({
        id,
        usage: { promptTokens: 3, completionTokens: 2 },
      }),
    ]);
  });

  it("sends the configured model name", async () => {
    const { app, t, runs, model } = await setup([
      [{ type: "text", text: "x" }],
    ]);
    writeSettings(t.db, { model: "qwen3" });
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, body.runId as string);
    expect(model.requests[0]).toMatchObject({ model: "qwen3" });
  });

  it("refuses a second run in the same session while one is active", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const id = await newSession(app);
    const first = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "1",
    });
    const second = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "2",
    });
    expect(second.status).toBe(409);
    await api(app, "POST", `/api/runs/${first.body.runId as string}/cancel`);
    await waitIdle(runs, first.body.runId as string);
  });

  it("records a model failure and keeps the partial text", async () => {
    const { app, runs, store } = await setup([
      [
        { type: "text", text: "Partial" },
        { type: "throw", message: "boom" },
      ],
    ]);
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, body.runId as string);
    expect(store.getRun(body.runId as string)).toMatchObject({
      status: "failed",
      error: "boom",
    });
    expect(store.listMessages(id).at(-1)?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
    });
  });
});

describe("continue", () => {
  it("appends to the last assistant message using prefill", async () => {
    const { app, runs, model, base } = await setup([
      [
        { type: "text", text: "Once upon" },
        { type: "usage", usage: { promptTokens: 5, completionTokens: 2 } },
      ],
      [
        { type: "text", text: " a time" },
        { type: "usage", usage: { promptTokens: 7, completionTokens: 3 } },
      ],
    ]);
    const id = await newSession(app);
    const first = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Story",
    });
    await waitIdle(runs, first.body.runId as string);
    const before = await api(app, "GET", `/api/sessions/${id}`);
    const assistantId = (before.body.messages as { id: string }[])[1]?.id;

    const listening = stream(base, id, {
      lastEventId: before.body.lastEventId as number,
      until: finished,
    });
    const cont = await api(app, "POST", `/api/sessions/${id}/continue`);
    expect(cont.status).toBe(202);
    const { got } = await listening;
    await waitIdle(runs, cont.body.runId as string);

    // The request ends with the assistant message, so llama-server continues it.
    expect(model.requests[1]).toEqual({
      kind: "chat",
      messages: [
        { role: "user", content: "Story" },
        { role: "assistant", content: [{ type: "text", text: "Once upon" }] },
      ],
      control: expect.any(RunControl),
      tools: [],
    });
    expect(got[2]?.event).toMatchObject({
      type: "message.started",
      data: { messageId: assistantId, continuing: true },
    });
    const after = await api(app, "GET", `/api/sessions/${id}`);
    expect(after.body.messages).toEqual([
      expect.objectContaining({ message: { role: "user", content: "Story" } }),
      {
        id: assistantId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Once upon a time" }],
        },
        model: null,
        reasoningEffort: null,
        agent: null,
        // The continuing call's usage replaces the first call's.
        usage: { promptTokens: 7, completionTokens: 3 },
      },
    ]);
  });

  it("refuses when the last message is not from the assistant", async () => {
    const { app } = await setup([]);
    const id = await newSession(app);
    expect(
      (await api(app, "POST", `/api/sessions/${id}/continue`)).status,
    ).toBe(409);
  });
});

describe("cancel", () => {
  it("stops the run and keeps the partial text", async () => {
    const { app, runs, store, base } = await setup([
      [
        { type: "text", text: "Once" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const id = await newSession(app);
    let runId = "";
    const listening = stream(base, id, {
      until: finished,
      onEvent: (r) => {
        if (r.event.type === "text.delta")
          void api(app, "POST", `/api/runs/${runId}/cancel`);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    runId = (
      await api(app, "POST", `/api/sessions/${id}/messages`, { content: "Hi" })
    ).body.runId as string;
    const { got } = await listening;

    expect(got.at(-1)?.event).toMatchObject({
      type: "run.finished",
      data: { reason: "cancelled" },
    });
    await waitIdle(runs, runId);
    expect(store.getRun(runId)?.status).toBe("cancelled");
    expect(store.listMessages(id).at(-1)?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Once" }],
    });
  });
});

describe("reattach", () => {
  it("replays events after Last-Event-ID", async () => {
    const { app, runs, base } = await setup([
      [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    ]);
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, body.runId as string);

    const all = await stream(base, id, { until: finished });
    const cut = all.got[3]?.id ?? 0;
    const rest = await stream(base, id, { lastEventId: cut, until: finished });
    expect(rest.got).toEqual(all.got.slice(4));
  });

  it("gives a snapshot of the in-flight message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, runs } = await setup([
      [
        { type: "reasoning", text: "think" },
        { type: "text", text: "Once " },
        { type: "text", text: "upon" },
        { type: "wait", until: gate },
        { type: "text", text: " a time" },
      ],
    ]);
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });

    await expect
      .poll(async () => {
        const s = await api(app, "GET", `/api/sessions/${id}`);
        return (
          s.body.activeRun as { message: { content: unknown } | null } | null
        )?.message?.content;
      })
      .toEqual([
        { type: "reasoning", text: "think" },
        { type: "text", text: "Once upon" },
      ]);
    const s = await api(app, "GET", `/api/sessions/${id}`);
    expect(s.body.activeRun).toMatchObject({
      runId: body.runId,
      message: { continuing: false },
      approvals: [],
    });
    expect(s.body.lastEventId).toBeGreaterThan(0);

    release();
    await waitIdle(runs, body.runId as string);
  });

  it("sends keepalive comments when idle", async () => {
    const { app, base } = await setup([], 30);
    const id = await newSession(app);
    const { comments } = await stream(base, id, {
      until: (_g, c) => c.filter((x) => x === "keepalive").length >= 2,
    });
    expect(
      comments.filter((c) => c === "keepalive").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("shutdown and recovery", () => {
  it("closes the server even while an event stream is open", async () => {
    const { app, base } = await setup([]);
    const id = await newSession(app);
    const res = await fetch(`${base}/api/sessions/${id}/events?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    await res.body?.cancel().catch(() => {});
  });

  it("ends active runs as interrupted on shutdown", async () => {
    const { app, runs, store } = await setup([
      [
        { type: "text", text: "Half" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    const runId = body.runId as string;
    await expect
      .poll(() => store.runEvents(runId).some((e) => e.type === "text.delta"))
      .toBe(true);

    await runs.shutdown();

    expect(store.getRun(runId)?.status).toBe("interrupted");
    expect(store.runEvents(runId).at(-1)?.type).toBe("run.interrupted");
    expect(store.listMessages(id).at(-1)?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Half" }],
    });
    expect(
      (await api(app, "POST", `/api/sessions/${id}/messages`, { content: "x" }))
        .status,
    ).toBe(503);
  });

  it("after a crash, saves partial text and marks runs interrupted", async () => {
    const { t, store } = await setup([]);
    // Simulate a crash: a run left 'running' with only some events stored.
    store.createSession("s1", "S", "T");
    store.createRun({ id: "r1", sessionId: "s1", kind: "loop", now: "T" });
    const base = { runId: "r1", sessionId: "s1", time: "T" };
    store.insertEvent({
      ...base,
      type: "run.started",
      data: { kind: "single" },
    });
    store.insertEvent({
      ...base,
      type: "message.started",
      data: { messageId: "m1", role: "assistant" },
    });
    store.insertEvent({
      ...base,
      type: "text.delta",
      data: { messageId: "m1", contentIndex: 0, text: "Lost " },
    });
    store.insertEvent({
      ...base,
      type: "text.delta",
      data: {
        messageId: "m1",
        contentIndex: 0,
        text: "words",
        usage: { promptTokens: 4, completionTokens: 1 },
      },
    });

    const fresh = new RunManager({
      store: new Store(t.db),
      settings: () => ({ ...DEFAULTS, autoRename: false }),
      model: () => new ScriptedModel([]),
    });
    expect(fresh.recover()).toEqual(["r1"]);

    expect(store.getRun("r1")?.status).toBe("interrupted");
    expect(store.runEvents("r1").at(-1)?.type).toBe("run.interrupted");
    expect(store.getMessage("m1")).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Lost words" }],
    });
    // The last running count streamed for it.
    expect(store.listMessages("s1").at(-1)?.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
    });
  });
});

describe("settings", () => {
  it("reads defaults, stores changes, and reports env overrides", async () => {
    const { app } = await setup([]);
    const first = await api(app, "GET", "/api/settings");
    expect(first.body).toEqual({
      effective: DEFAULTS,
      stored: {},
      overriddenByEnv: {},
    });

    const put = await api(app, "PUT", "/api/settings", {
      model: "qwen3",
      port: 5000,
    });
    expect(put.body.effective).toEqual({
      ...DEFAULTS,
      model: "qwen3",
      port: 5000,
    });
    expect(put.body.stored).toEqual({ model: "qwen3", port: 5000 });

    expect((await api(app, "PUT", "/api/settings", { port: "x" })).status).toBe(
      400,
    );
    expect(
      (await api(app, "PUT", "/api/settings", { llamaServerUrl: "nope" }))
        .status,
    ).toBe(400);
  });

  it("lets environment variables override stored settings", async () => {
    const { t } = await setup([]);
    writeSettings(t.db, { model: "stored", port: 5000 });
    const view = readSettings(t.db, { HARNESS_MODEL: "from-env" });
    expect(view.effective).toMatchObject({ model: "from-env", port: 5000 });
    expect(view.overriddenByEnv).toEqual({ model: "HARNESS_MODEL" });
    expect(() => readSettings(t.db, { HARNESS_PORT: "abc" })).toThrow(
      /HARNESS_PORT/,
    );
  });
});

describe("model selection", () => {
  const text: ScriptStep[] = [{ type: "text", text: "ok" }];

  async function turn(
    app: FastifyInstance,
    runs: RunManager,
    id: string,
    body: Record<string, unknown>,
    path = "messages",
  ) {
    const res = await api(app, "POST", `/api/sessions/${id}/${path}`, body);
    expect(res.status).toBe(202);
    await waitIdle(runs, res.body.runId as string);
    return res.body.runId as string;
  }

  it("lists llama-server's models", async () => {
    const { app } = await setup([], undefined, async () => [
      { id: "a", status: "loaded" },
      { id: "b", status: "unloaded" },
    ]);
    const res = await app.inject({ url: "/api/models", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: "a", status: "loaded" },
      { id: "b", status: "unloaded" },
    ]);
  });

  it("reports llama-server being unreachable as 502", async () => {
    const { app } = await setup([], undefined, () =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    const res = await app.inject({ url: "/api/models", headers: auth });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("uses a message's model, remembers it for the session, and records it", async () => {
    const { app, runs, store, model } = await setup([text, text]);
    const id = await newSession(app);

    const runId = await turn(app, runs, id, { content: "1", model: "qwen" });
    expect(model.requests[0]).toMatchObject({ model: "qwen" });
    expect(store.getSession(id)?.model).toBe("qwen");
    expect(store.getRun(runId)?.model).toBe("qwen");
    expect(store.runEvents(runId)[0]).toMatchObject({
      type: "run.started",
      data: { model: "qwen" },
    });
    expect(store.listMessages(id).map((m) => m.model)).toEqual([null, "qwen"]);

    // The next message without a model uses the session's choice.
    await turn(app, runs, id, { content: "2" });
    expect(model.requests[1]).toMatchObject({ model: "qwen" });
  });

  it("prefers the session's model over the default setting", async () => {
    const { app, runs, t, model } = await setup([text, text, text]);
    writeSettings(t.db, { model: "default-model" });
    const id = await newSession(app);

    await turn(app, runs, id, { content: "1" });
    expect(model.requests[0]).toMatchObject({ model: "default-model" });

    const patched = await api(app, "PATCH", `/api/sessions/${id}`, {
      model: "chosen",
    });
    expect(patched.body).toMatchObject({ id, model: "chosen" });
    await turn(app, runs, id, { content: "2" });
    expect(model.requests[1]).toMatchObject({ model: "chosen" });

    // null returns the session to the default.
    await api(app, "PATCH", `/api/sessions/${id}`, { model: null });
    await turn(app, runs, id, { content: "3" });
    expect(model.requests[2]).toMatchObject({ model: "default-model" });
  });

  it("sends no model when neither the session nor the setting has one", async () => {
    const { app, runs, store, model } = await setup([text]);
    const id = await newSession(app);
    const runId = await turn(app, runs, id, { content: "1" });
    expect(model.requests[0]).not.toHaveProperty("model");
    expect(store.getRun(runId)?.model).toBeNull();
  });

  it("continues with a different model and records it on the message", async () => {
    const { app, runs, store, model } = await setup([
      [{ type: "text", text: "Once" }],
      [{ type: "text", text: " more" }],
    ]);
    const id = await newSession(app);
    await turn(app, runs, id, { content: "1", model: "first" });
    await turn(app, runs, id, { model: "second" }, "continue");

    expect(model.requests[1]).toMatchObject({ model: "second" });
    expect(store.listMessages(id).at(-1)).toMatchObject({
      message: { content: [{ type: "text", text: "Once more" }] },
      model: "second",
    });
    expect(store.getSession(id)?.model).toBe("second");
  });

  it("includes the model in the in-flight snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: gate },
      ],
    ]);
    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "1",
      model: "qwen",
    });
    const s = await api(app, "GET", `/api/sessions/${id}`);
    expect(s.body.activeRun).toMatchObject({ model: "qwen" });
    release();
    await waitIdle(runs, body.runId as string);
  });

  it("rejects an empty model name and unknown sessions", async () => {
    const { app } = await setup([]);
    const id = await newSession(app);
    expect(
      (await api(app, "PATCH", `/api/sessions/${id}`, { model: "" })).status,
    ).toBe(400);
    expect(
      (
        await api(app, "POST", `/api/sessions/${id}/messages`, {
          content: "x",
          model: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(app, "PATCH", "/api/sessions/nope", { model: "a" })).status,
    ).toBe(404);
  });
});

describe("reasoning", () => {
  const text: ScriptStep[] = [{ type: "text", text: "ok" }];

  async function turn(
    app: FastifyInstance,
    runs: RunManager,
    id: string,
    body: Record<string, unknown>,
  ) {
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, body);
    expect(res.status).toBe(202);
    await waitIdle(runs, res.body.runId as string);
    return res.body.runId as string;
  }

  it("sends a message's effort, remembers it, and records it", async () => {
    const { app, runs, store, model } = await setup([text, text]);
    const id = await newSession(app);

    const runId = await turn(app, runs, id, {
      content: "1",
      reasoningEffort: "none",
    });
    expect(model.requests[0]).toMatchObject({ reasoningEffort: "none" });
    expect(store.getSession(id)?.reasoning_effort).toBe("none");
    expect(store.getRun(runId)?.reasoning_effort).toBe("none");
    expect(store.runEvents(runId)[0]).toMatchObject({
      type: "run.started",
      data: { reasoningEffort: "none" },
    });
    expect(store.listMessages(id).at(-1)?.reasoningEffort).toBe("none");

    await turn(app, runs, id, { content: "2" });
    expect(model.requests[1]).toMatchObject({ reasoningEffort: "none" });
  });

  it("uses the default from Settings unless the session chose one", async () => {
    const { app, runs, t, model } = await setup([text, text, text, text]);
    writeSettings(t.db, { reasoningEffort: "low" });
    const id = await newSession(app);

    await turn(app, runs, id, { content: "1" });
    expect(model.requests[0]).toMatchObject({ reasoningEffort: "low" });

    await api(app, "PATCH", `/api/sessions/${id}`, { reasoningEffort: "high" });
    await turn(app, runs, id, { content: "2" });
    expect(model.requests[1]).toMatchObject({ reasoningEffort: "high" });

    // Changing only the model leaves the effort alone.
    await api(app, "PATCH", `/api/sessions/${id}`, { model: "m" });
    await turn(app, runs, id, { content: "3" });
    expect(model.requests[2]).toMatchObject({
      model: "m",
      reasoningEffort: "high",
    });

    await api(app, "PATCH", `/api/sessions/${id}`, { reasoningEffort: null });
    await turn(app, runs, id, { content: "4" });
    expect(model.requests[3]).toMatchObject({
      model: "m",
      reasoningEffort: "low",
    });
  });

  it("sends no effort when neither the session nor Settings has one", async () => {
    const { app, runs, model } = await setup([text]);
    const id = await newSession(app);
    await turn(app, runs, id, { content: "1" });
    expect(model.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it("rejects an empty change", async () => {
    const { app } = await setup([]);
    const id = await newSession(app);
    expect((await api(app, "PATCH", `/api/sessions/${id}`, {})).status).toBe(
      400,
    );
    expect(
      (await api(app, "PATCH", `/api/sessions/${id}`, { reasoningEffort: "" }))
        .status,
    ).toBe(400);
  });

  it("lets HARNESS_REASONING_EFFORT override the stored default", async () => {
    const { t } = await setup([]);
    writeSettings(t.db, { reasoningEffort: "low" });
    const view = readSettings(t.db, { HARNESS_REASONING_EFFORT: "none" });
    expect(view.effective.reasoningEffort).toBe("none");
    expect(view.overriddenByEnv).toEqual({
      reasoningEffort: "HARNESS_REASONING_EFFORT",
    });
  });

  it("reports a model's reasoning levels", async () => {
    const asked: (string | undefined)[] = [];
    const t = tempDatabase();
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({ ...DEFAULTS, autoRename: false }),
      model: () => new ScriptedModel([]),
    });
    const app = buildServer({
      store,
      runs,
      token: TOKEN,
      env: {},
      reasoningLevels: async (m) => {
        asked.push(m);
        if (m === "unloaded") return { unavailable: "model is not loaded" };
        if (m === "down") throw new Error("connect ECONNREFUSED");
        return { levels: ["low", "high"] };
      },
    });
    cleanups.push(t.cleanup, () => app.close());

    const ok = await api(app, "GET", "/api/models/reasoning-levels?model=qwen");
    expect(ok.body).toEqual({ levels: ["low", "high"] });
    const bad = await api(
      app,
      "GET",
      "/api/models/reasoning-levels?model=unloaded",
    );
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ unavailable: "model is not loaded" });
    const down = await api(
      app,
      "GET",
      "/api/models/reasoning-levels?model=down",
    );
    expect(down.status).toBe(502);
    expect(down.body).toEqual({ error: "connect ECONNREFUSED" });
    await api(app, "GET", "/api/models/reasoning-levels");
    expect(asked).toEqual(["qwen", "unloaded", "down", undefined]);
  });

  it("reports a model's context size", async () => {
    const asked: (string | undefined)[] = [];
    const t = tempDatabase();
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({ ...DEFAULTS, autoRename: false }),
      model: () => new ScriptedModel([]),
    });
    const app = buildServer({
      store,
      runs,
      token: TOKEN,
      env: {},
      contextSize: async (m) => {
        asked.push(m);
        if (m === "unloaded") return { unavailable: "model is not loaded" };
        if (m === "down") throw new Error("connect ECONNREFUSED");
        return { contextSize: 8192 };
      },
    });
    cleanups.push(t.cleanup, () => app.close());

    const ok = await api(app, "GET", "/api/models/context-size?model=qwen");
    expect(ok.body).toEqual({ contextSize: 8192 });
    const bad = await api(
      app,
      "GET",
      "/api/models/context-size?model=unloaded",
    );
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ unavailable: "model is not loaded" });
    const down = await api(app, "GET", "/api/models/context-size?model=down");
    expect(down.status).toBe(502);
    expect(down.body).toEqual({ error: "connect ECONNREFUSED" });
    await api(app, "GET", "/api/models/context-size");
    expect(asked).toEqual(["qwen", "unloaded", "down", undefined]);
  });

  it("reads the context size from llama-server's /props by default", async () => {
    const llama = new FakeLlamaServer();
    const llamaUrl = await llama.start();
    cleanups.push(() => llama.stop());
    llama.onGet("/props", {
      default_generation_settings: { params: {}, n_ctx: 4096 },
    });
    const t = tempDatabase();
    writeSettings(t.db, { llamaServerUrl: llamaUrl });
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({ ...DEFAULTS, autoRename: false }),
      model: () => new ScriptedModel([]),
    });
    const app = buildServer({ store, runs, token: TOKEN, env: {} });
    cleanups.push(t.cleanup, () => app.close());

    const res = await api(app, "GET", "/api/models/context-size?model=qwen");
    expect(res.body).toEqual({ contextSize: 4096 });
    expect(llama.requests[0]?.path).toBe("/props?autoload=false&model=qwen");
  });
});

describe("stop thinking", () => {
  it("ends reasoning through llama-server's control endpoint", async () => {
    const llama = new FakeLlamaServer();
    const llamaUrl = await llama.start();
    llama.reply(
      {
        frames: [
          chatChunk({ role: "assistant", content: null }),
          chatChunk({ reasoning_content: "Hmm" }),
          { hang: true },
        ],
      },
      { json: { success: true } },
    );
    const t = tempDatabase();
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({
        ...DEFAULTS,
        autoRename: false,
        model: "qwen",
        llamaServerUrl: llamaUrl,
      }),
      model: (s) => new LlamaServerAdapter({ baseUrl: s.llamaServerUrl }),
    });
    const app = buildServer({ store, runs, token: TOKEN, env: {} });
    cleanups.push(
      t.cleanup,
      () => app.close(),
      () => llama.stop(),
    );

    const id = await newSession(app);
    const { body } = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    const runId = body.runId as string;
    await expect
      .poll(() =>
        store.runEvents(runId).some((e) => e.type === "reasoning.delta"),
      )
      .toBe(true);

    const ended = await api(app, "POST", `/api/runs/${runId}/end-reasoning`);
    expect(ended.body).toEqual({ ok: true });
    expect(llama.requests[0]?.body).toMatchObject({ reasoning_control: true });
    expect(llama.requests[1]).toMatchObject({
      path: "/v1/chat/completions/control",
      body: { id: "chatcmpl-test", action: "reasoning_end", model: "qwen" },
    });

    await api(app, "POST", `/api/runs/${runId}/cancel`);
    await waitIdle(runs, runId);
    const after = await api(app, "POST", `/api/runs/${runId}/end-reasoning`);
    expect(after.body).toEqual({
      ok: false,
      message: "The run is not active.",
    });
    expect(
      (await api(app, "POST", "/api/runs/nope/end-reasoning")).status,
    ).toBe(404);
  });
});

describe("loading a model", () => {
  it("asks llama-server to load and passes on the result", async () => {
    const asked: string[] = [];
    const t = tempDatabase();
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({ ...DEFAULTS, autoRename: false }),
      model: () => new ScriptedModel([]),
    });
    const app = buildServer({
      store,
      runs,
      token: TOKEN,
      env: {},
      loadModel: async (m) => {
        asked.push(m);
        if (m === "down") throw new Error("connect ECONNREFUSED");
        if (m === "nope") return { ok: false, message: "model is not found" };
        return { ok: true, alreadyRunning: m === "running" };
      },
    });
    cleanups.push(t.cleanup, () => app.close());

    expect(
      (await api(app, "POST", "/api/models/load", { model: "qwen" })).body,
    ).toEqual({ ok: true, alreadyRunning: false });
    expect(
      (await api(app, "POST", "/api/models/load", { model: "running" })).body,
    ).toEqual({ ok: true, alreadyRunning: true });
    expect(
      (await api(app, "POST", "/api/models/load", { model: "nope" })).body,
    ).toEqual({ ok: false, message: "model is not found" });
    const down = await api(app, "POST", "/api/models/load", { model: "down" });
    expect(down.status).toBe(502);
    expect(
      (await api(app, "POST", "/api/models/load", { model: "" })).status,
    ).toBe(400);
    expect(asked).toEqual(["qwen", "running", "nope", "down"]);
  });
});

describe("renaming a session", () => {
  it("trims the title and rejects an empty one", async () => {
    const { app } = await setup([]);
    const id = await newSession(app);
    const renamed = await api(app, "PATCH", `/api/sessions/${id}`, {
      title: "  The lighthouse  ",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("The lighthouse");
    expect(
      (await api(app, "PATCH", `/api/sessions/${id}`, { title: "   " })).status,
    ).toBe(400);
    expect(
      (await api(app, "POST", "/api/sessions", { title: "  " })).status,
    ).toBe(400);
    const list = await api(app, "GET", "/api/sessions");
    expect((list.body as unknown as { title: string }[])[0]?.title).toBe(
      "The lighthouse",
    );
  });

  it("renames and changes choices in one request", async () => {
    const { app } = await setup([]);
    const id = await newSession(app);
    const { body } = await api(app, "PATCH", `/api/sessions/${id}`, {
      title: "A",
      model: "qwen3",
    });
    expect(body).toMatchObject({ title: "A", model: "qwen3" });
  });
});

describe("trash", () => {
  async function trashed(app: FastifyInstance) {
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/trash`);
    expect(res.status).toBe(200);
    return id;
  }

  it("moves a session to the trash, where it can be read but not changed", async () => {
    const { app } = await setup([]);
    const id = await trashed(app);

    const list = await api(app, "GET", "/api/sessions");
    expect(list.body).toEqual([]);
    const trash = await api(app, "GET", "/api/trash");
    expect(trash.body.sessions).toMatchObject([{ id }]);

    const detail = await api(app, "GET", `/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.body.session as { trashed_at: unknown }).trashed_at).toEqual(
      expect.any(String),
    );

    for (const [method, url, body] of [
      ["POST", `/api/sessions/${id}/messages`, { content: "Hi" }],
      ["POST", `/api/sessions/${id}/continue`, {}],
      ["PATCH", `/api/sessions/${id}`, { title: "New" }],
      ["POST", `/api/sessions/${id}/trash`, undefined],
    ] as const) {
      expect((await api(app, method, url, body)).status).toBe(409);
    }
  });

  it("refuses to trash a session while a run is in progress", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const id = await newSession(app);
    const run = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    const runId = run.body.runId as string;
    expect((await api(app, "POST", `/api/sessions/${id}/trash`)).status).toBe(
      409,
    );
    await api(app, "POST", `/api/runs/${runId}/cancel`);
    await waitIdle(runs, runId);
    expect((await api(app, "POST", `/api/sessions/${id}/trash`)).status).toBe(
      200,
    );
  });

  it("sends a stored session.trashed event with no run", async () => {
    const { app, base } = await setup([]);
    const id = await newSession(app);
    const listening = stream(base, id, {
      until: (got) => got.some((r) => r.event.type === "session.trashed"),
    });
    await new Promise((r) => setTimeout(r, 50));
    await api(app, "POST", `/api/sessions/${id}/trash`);
    const { got } = await listening;
    expect(got.at(-1)?.event).toMatchObject({
      type: "session.trashed",
      runId: null,
      sessionId: id,
      data: {},
    });

    // It is replayed like other events.
    const replay = await stream(base, id, {
      lastEventId: 0,
      until: (r) => r.length > 0,
    });
    expect(replay.got[0]?.id).toBe(got.at(-1)?.id);
  });

  it("restores a session", async () => {
    const { app } = await setup([]);
    const id = await trashed(app);
    const restored = await api(app, "POST", `/api/sessions/${id}/restore`);
    expect(restored.body).toMatchObject({ id, trashed_at: null });
    expect(await api(app, "GET", "/api/sessions")).toMatchObject({
      body: [{ id }],
    });
    expect((await api(app, "POST", `/api/sessions/${id}/restore`)).status).toBe(
      409,
    );
  });

  it("deletes only a trashed session, with all its rows", async () => {
    const { app, runs, t, store } = await setup([
      [{ type: "text", text: "Hello" }],
    ]);
    const id = await newSession(app);
    const keep = await newSession(app);
    const run = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, run.body.runId as string);
    store.allowToolForSession(id, "clock", "T");

    expect((await api(app, "DELETE", `/api/sessions/${id}`)).status).toBe(409);
    await api(app, "POST", `/api/sessions/${id}/trash`);
    expect((await api(app, "DELETE", `/api/sessions/${id}`)).status).toBe(200);
    expect((await api(app, "GET", `/api/sessions/${id}`)).status).toBe(404);
    expect((await api(app, "DELETE", `/api/sessions/${id}`)).status).toBe(404);

    const count = (table: string) =>
      (
        t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    for (const table of [
      "messages",
      "runs",
      "run_messages",
      "events",
      "session_tool_approvals",
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(store.getSession(keep)).toBeDefined();
  });

  it("empties the trash", async () => {
    const { app } = await setup([]);
    await trashed(app);
    await trashed(app);
    const keep = await newSession(app);
    const res = await api(app, "DELETE", "/api/trash");
    expect(res.body).toEqual({ purged: { projects: 0, sessions: 2 } });
    expect((await api(app, "GET", "/api/trash")).body).toEqual({
      projects: [],
      sessions: [],
    });
    expect(await api(app, "GET", "/api/sessions")).toMatchObject({
      body: [{ id: keep }],
    });
  });
});

describe("projects", () => {
  async function newProject(
    app: FastifyInstance,
    body: Record<string, unknown> = { name: "Harbour stories" },
  ) {
    const res = await api(app, "POST", "/api/projects", body);
    expect(res.status).toBe(201);
    return res.body as { id: string; last_used_at: string };
  }

  async function sessionIn(app: FastifyInstance, projectId: string) {
    const res = await api(app, "POST", "/api/sessions", { projectId });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const ids = (body: unknown) => (body as { id: string }[]).map((r) => r.id);

  it("creates, reads and edits a project", async () => {
    const { app } = await setup([]);
    const created = await api(app, "POST", "/api/projects", {
      name: "  Harbour stories  ",
    });
    expect(created.body).toMatchObject({
      name: "Harbour stories",
      description: "",
      trashed_at: null,
    });
    const id = created.body.id as string;
    expect(
      (await api(app, "POST", "/api/projects", { name: " " })).status,
    ).toBe(400);

    const edited = await api(app, "PATCH", `/api/projects/${id}`, {
      name: "Sea stories",
      description: "Short pieces set by the sea.",
    });
    expect(edited.body).toMatchObject({
      name: "Sea stories",
      description: "Short pieces set by the sea.",
    });
    expect(
      (await api(app, "PATCH", `/api/projects/${id}`, { name: "" })).status,
    ).toBe(400);
    expect((await api(app, "PATCH", `/api/projects/${id}`, {})).status).toBe(
      400,
    );
    expect((await api(app, "GET", `/api/projects/${id}`)).body).toMatchObject({
      name: "Sea stories",
    });
    expect((await api(app, "GET", "/api/projects/nope")).status).toBe(404);
  });

  it("keeps project sessions apart from standalone sessions", async () => {
    const { app } = await setup([]);
    const p = await newProject(app);
    const standalone = await newSession(app);
    const inProject = await sessionIn(app, p.id);

    expect(ids((await api(app, "GET", "/api/sessions")).body)).toEqual([
      standalone,
    ]);
    expect(
      ids((await api(app, "GET", `/api/sessions?projectId=${p.id}`)).body),
    ).toEqual([inProject]);
    const detail = await api(app, "GET", `/api/sessions/${inProject}`);
    expect(detail.body.session).toMatchObject({ project_id: p.id });
    expect(detail.body.project).toMatchObject({ id: p.id });
    expect(
      (await api(app, "GET", `/api/sessions/${standalone}`)).body.project,
    ).toBeNull();

    expect(
      (await api(app, "POST", "/api/sessions", { projectId: "nope" })).status,
    ).toBe(404);
  });

  it("lists projects most recently used first", async () => {
    let tick = 0;
    const t = tempDatabase();
    const store = new Store(t.db);
    const model = new ScriptedModel([[{ type: "text", text: "ok" }]]);
    const runs = new RunManager({
      store,
      settings: () => ({
        ...readSettings(t.db, {}).effective,
        autoRename: false,
      }),
      model: () => model,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
    const app = buildServer({
      store,
      runs,
      token: TOKEN,
      env: {},
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
    cleanups.push(t.cleanup, () => app.close());

    const a = await newProject(app, { name: "A" });
    const b = await newProject(app, { name: "B" });
    const c = await newProject(app, { name: "C" });
    const list = async () => ids((await api(app, "GET", "/api/projects")).body);
    expect(await list()).toEqual([c.id, b.id, a.id]);

    // Creating a session in it.
    const inA = await sessionIn(app, a.id);
    expect(await list()).toEqual([a.id, c.id, b.id]);
    // Editing it.
    await api(app, "PATCH", `/api/projects/${b.id}`, { description: "x" });
    expect(await list()).toEqual([b.id, a.id, c.id]);
    // Sending a message in one of its sessions.
    const run = await api(app, "POST", `/api/sessions/${inA}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, run.body.runId as string);
    expect(await list()).toEqual([a.id, b.id, c.id]);
    // Opening it does not count.
    await api(app, "GET", `/api/projects/${c.id}`);
    expect(await list()).toEqual([a.id, b.id, c.id]);
  });

  it("trashes a project with its sessions and emits session.trashed for each", async () => {
    const { app, base } = await setup([]);
    const p = await newProject(app);
    const s1 = await sessionIn(app, p.id);
    const s2 = await sessionIn(app, p.id);
    const listening = stream(base, s1, {
      until: (got) => got.some((r) => r.event.type === "session.trashed"),
    });
    await new Promise((r) => setTimeout(r, 50));

    expect((await api(app, "POST", `/api/projects/${p.id}/trash`)).status).toBe(
      200,
    );
    const { got } = await listening;
    expect(got.at(-1)?.event).toMatchObject({
      type: "session.trashed",
      runId: null,
    });

    expect(ids((await api(app, "GET", "/api/projects")).body)).toEqual([]);
    const trash = await api(app, "GET", "/api/trash");
    const projects = trash.body.projects as {
      id: string;
      sessions: { id: string }[];
    }[];
    expect(projects.map((x) => x.id)).toEqual([p.id]);
    expect(ids(projects[0]?.sessions).sort()).toEqual([s1, s2].sort());
    expect(trash.body.sessions).toEqual([]);

    for (const [method, url, body] of [
      ["POST", `/api/projects/${p.id}/trash`, undefined],
      ["PATCH", `/api/projects/${p.id}`, { name: "X" }],
      ["POST", "/api/sessions", { projectId: p.id }],
      ["POST", `/api/sessions/${s1}/messages`, { content: "Hi" }],
    ] as const) {
      expect((await api(app, method, url, body)).status).toBe(409);
    }
  });

  it("refuses to trash a project while one of its sessions has a run", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const p = await newProject(app);
    const s = await sessionIn(app, p.id);
    const run = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
    });
    const runId = run.body.runId as string;
    expect((await api(app, "POST", `/api/projects/${p.id}/trash`)).status).toBe(
      409,
    );
    await api(app, "POST", `/api/runs/${runId}/cancel`);
    await waitIdle(runs, runId);
    expect((await api(app, "POST", `/api/projects/${p.id}/trash`)).status).toBe(
      200,
    );
  });

  it("restores a project with the sessions trashed with it, not earlier ones", async () => {
    const { app } = await setup([]);
    const p = await newProject(app);
    const earlier = await sessionIn(app, p.id);
    const withProject = await sessionIn(app, p.id);
    await api(app, "POST", `/api/sessions/${earlier}/trash`);
    await api(app, "POST", `/api/projects/${p.id}/trash`);

    const trash = await api(app, "GET", "/api/trash");
    expect(ids(trash.body.sessions)).toEqual([earlier]);

    expect(
      (await api(app, "POST", `/api/projects/${p.id}/restore`)).body,
    ).toMatchObject({ trashed_at: null });
    expect(
      ids((await api(app, "GET", `/api/sessions?projectId=${p.id}`)).body),
    ).toEqual([withProject]);
    expect(ids((await api(app, "GET", "/api/trash")).body.sessions)).toEqual([
      earlier,
    ]);
    expect(
      (await api(app, "POST", `/api/projects/${p.id}/restore`)).status,
    ).toBe(409);
  });

  it("restoring a session of a trashed project asks which sessions come back", async () => {
    const { app } = await setup([]);
    const setupProject = async () => {
      const p = await newProject(app);
      const s1 = await sessionIn(app, p.id);
      const s2 = await sessionIn(app, p.id);
      await api(app, "POST", `/api/projects/${p.id}/trash`);
      return { p, s1, s2 };
    };

    const one = await setupProject();
    expect(
      (await api(app, "POST", `/api/sessions/${one.s1}/restore`)).status,
    ).toBe(409);
    await api(app, "POST", `/api/sessions/${one.s1}/restore`, {
      project: "all",
    });
    expect(
      ids(
        (await api(app, "GET", `/api/sessions?projectId=${one.p.id}`)).body,
      ).sort(),
    ).toEqual([one.s1, one.s2].sort());

    const two = await setupProject();
    await api(app, "POST", `/api/sessions/${two.s1}/restore`, {
      project: "only",
    });
    expect(
      ids((await api(app, "GET", `/api/sessions?projectId=${two.p.id}`)).body),
    ).toEqual([two.s1]);
    expect(ids((await api(app, "GET", "/api/projects")).body)).toContain(
      two.p.id,
    );
    // The other session stays in the trash, now as a session of its own.
    const trash = await api(app, "GET", "/api/trash");
    expect(ids(trash.body.sessions)).toEqual([two.s2]);
    expect(trash.body.projects).toEqual([]);
  });

  it("deletes only a trashed project, with its sessions", async () => {
    const { app, store } = await setup([]);
    const p = await newProject(app);
    const s1 = await sessionIn(app, p.id);
    const s2 = await sessionIn(app, p.id);
    await api(app, "POST", `/api/sessions/${s1}/trash`);
    expect((await api(app, "DELETE", `/api/projects/${p.id}`)).status).toBe(
      409,
    );
    await api(app, "POST", `/api/projects/${p.id}/trash`);
    expect((await api(app, "DELETE", `/api/projects/${p.id}`)).status).toBe(
      200,
    );
    expect(store.getProject(p.id)).toBeUndefined();
    expect(store.getSession(s1)).toBeUndefined();
    expect(store.getSession(s2)).toBeUndefined();
  });

  it("empties projects and sessions from the trash", async () => {
    const { app, store } = await setup([]);
    const p = await newProject(app);
    await sessionIn(app, p.id);
    await api(app, "POST", `/api/projects/${p.id}/trash`);
    const s = await newSession(app);
    await api(app, "POST", `/api/sessions/${s}/trash`);
    expect((await api(app, "DELETE", "/api/trash")).body).toEqual({
      purged: { projects: 1, sessions: 1 },
    });
    expect(store.getProject(p.id)).toBeUndefined();
    expect(
      (
        store.db.prepare("SELECT count(*) AS n FROM sessions").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});
