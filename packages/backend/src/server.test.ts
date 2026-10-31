import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type HarnessEvent,
  type ScriptStep,
} from "@harness/core";
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

async function setup(scripts: ScriptStep[][], keepaliveMs?: number) {
  const t = tempDatabase();
  const store = new Store(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => readSettings(t.db, {}).effective,
    model: () => model,
  });
  const app = buildServer({
    store,
    runs,
    token: TOKEN,
    env: {},
    ...(keepaliveMs ? { keepaliveMs } : {}),
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, base, model };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
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
      "message.started",
      "text.delta",
      "text.delta",
      "text.end",
      "message.finished",
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
    expect(got[1]?.event).toMatchObject({
      data: { messageId: (session.body.messages as { id: string }[])[1]?.id },
    });
    expect(session.body.activeRun).toBeNull();
    expect(session.body.lastEventId).toBe(ids.at(-1));
    expect(model.requests[0]).toEqual({
      kind: "chat",
      messages: [{ role: "user", content: "Hi" }],
    });
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
      [{ type: "text", text: "Once upon" }],
      [{ type: "text", text: " a time" }],
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
    });
    expect(got[1]?.event).toMatchObject({
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
        return (s.body.activeRun as { content: unknown } | null)?.content;
      })
      .toEqual([
        { type: "reasoning", text: "think" },
        { type: "text", text: "Once upon" },
      ]);
    const s = await api(app, "GET", `/api/sessions/${id}`);
    expect(s.body.activeRun).toMatchObject({
      runId: body.runId,
      continuing: false,
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
    store.createRun({
      id: "r1",
      sessionId: "s1",
      kind: "single",
      messageId: "m1",
      now: "T",
    });
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
      data: { messageId: "m1", contentIndex: 0, text: "words" },
    });

    const fresh = new RunManager({
      store: new Store(t.db),
      settings: () => DEFAULTS,
      model: () => new ScriptedModel([]),
    });
    expect(fresh.recover()).toEqual(["r1"]);

    expect(store.getRun("r1")?.status).toBe("interrupted");
    expect(store.runEvents("r1").at(-1)?.type).toBe("run.interrupted");
    expect(store.getMessage("m1")).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Lost words" }],
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
