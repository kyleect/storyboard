import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type ModelAdapter,
  type ModelChunk,
  type ModelRequest,
  type ScriptStep,
} from "@harness/core";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS, readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Auto-rename (auto-rename plan). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/**
 * Sends title calls (system message = the title prompt) to one scripted
 * model and run calls to another, since the two run side by side.
 */
class SplitModel implements ModelAdapter {
  constructor(
    private readonly prompt: () => string,
    readonly run: ScriptedModel,
    readonly title: ScriptedModel,
  ) {}

  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    const first = request.kind === "chat" ? request.messages[0] : undefined;
    const isTitle = first?.role === "system" && first.content === this.prompt();
    return (isTitle ? this.title : this.run).stream(request, signal);
  }
}

const reply: ScriptStep[] = [
  { type: "text", text: "Once upon a time." },
  { type: "finish", reason: "stop" },
];

function gate() {
  let open = () => {};
  const until = new Promise<void>((resolve) => (open = resolve));
  return { until, open };
}

async function setup(
  runScripts: ScriptStep[][],
  titleScripts: ScriptStep[][],
  settings: Record<string, unknown> = {},
) {
  const t = tempDatabase();
  writeSettings(t.db, settings);
  const store = new Store(t.db);
  const current = () => readSettings(t.db, {}).effective;
  const model = new SplitModel(
    () => current().titlePrompt,
    new ScriptedModel(runScripts),
    new ScriptedModel(titleScripts),
  );
  const runs = new RunManager({
    store,
    settings: current,
    model: () => model,
  });
  const app = buildServer({ store, runs, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (res.body ? res.json() : undefined) as any,
  };
}

async function newSession(app: FastifyInstance, title?: string) {
  const { body } = await api(
    app,
    "POST",
    "/api/sessions",
    title ? { title } : {},
  );
  return body.id as string;
}

/** Sends a message and waits for its run and any title call to end. */
async function send(
  app: FastifyInstance,
  runs: RunManager,
  id: string,
  content = "A lighthouse keeper finds a letter.",
) {
  const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
    content,
  });
  expect(res.status).toBe(202);
  await expect.poll(() => runs.isActive(res.body.runId)).toBe(false);
  await runs.titlesSettled();
  return res.body.runId as string;
}

function renames(store: Store, id: string) {
  return store
    .eventsAfter(id, 0)
    .filter((e) => e.type === "session.renamed")
    .map((e) => e.data);
}

const title = (store: Store, id: string) => store.getSession(id)?.title;

describe("auto-rename from the model", () => {
  it("renames with the model's cleaned title and records the call", async () => {
    const { app, runs, store, model } = await setup(
      [reply],
      [
        [
          { type: "text", text: "\"The Keeper's " },
          { type: "text", text: 'Letter."\nextra' },
          { type: "usage", usage: { promptTokens: 30, completionTokens: 6 } },
          { type: "finish", reason: "stop" },
        ],
      ],
      { titleModel: "titler", reasoningEffort: "low" },
    );
    const id = await newSession(app);
    await send(app, runs, id);

    expect(title(store, id)).toBe("The Keeper's Letter");
    expect(renames(store, id)).toEqual([
      {
        title: "The Keeper's Letter",
        source: "model",
        model: "titler",
        usage: { promptTokens: 30, completionTokens: 6 },
      },
    ]);
    const request = model.title.requests[0] as ChatRequest;
    expect(request.model).toBe("titler");
    expect(request.reasoningEffort).toBe("low");
    expect(request.messages).toEqual([
      { role: "system", content: DEFAULTS.titlePrompt },
      { role: "user", content: "A lighthouse keeper finds a letter." },
    ]);
    // The run is not affected.
    expect(model.run.requests).toHaveLength(1);
  });

  it("uses the session's model and effort when no title model is set", async () => {
    const { app, runs, model } = await setup(
      [reply],
      [[{ type: "text", text: "T" }]],
    );
    const id = await newSession(app);
    await api(app, "PATCH", `/api/sessions/${id}`, {
      model: "m1",
      reasoningEffort: "high",
    });
    await send(app, runs, id);
    const request = model.title.requests[0] as ChatRequest;
    expect(request.model).toBe("m1");
    expect(request.reasoningEffort).toBe("high");
  });

  it("keeps reasoning out of the title", async () => {
    const { app, runs, store } = await setup(
      [reply],
      [
        [
          { type: "reasoning", text: "Hmm, a title." },
          { type: "text", text: "The Letter" },
        ],
      ],
    );
    const id = await newSession(app);
    await send(app, runs, id);
    expect(title(store, id)).toBe("The Letter");
  });

  it("falls back to the message when the call fails", async () => {
    const { app, runs, store } = await setup(
      [reply],
      [[{ type: "throw", message: "server down" }]],
    );
    const id = await newSession(app);
    await send(app, runs, id, "The letter.\nIt was old.");
    expect(title(store, id)).toBe("The letter");
    expect(renames(store, id)).toEqual([
      { title: "The letter", source: "message", model: null, usage: null },
    ]);
  });

  it("falls back to the message when the model writes nothing usable", async () => {
    const { app, runs, store } = await setup(
      [reply],
      [[{ type: "text", text: ' "" ' }]],
    );
    const id = await newSession(app);
    await send(app, runs, id, "The letter");
    expect(title(store, id)).toBe("The letter");
    expect(renames(store, id)[0]?.source).toBe("message");
  });

  it("leaves the title when neither gives anything usable", async () => {
    const { app, runs, store } = await setup(
      [reply],
      [[{ type: "text", text: "" }]],
    );
    const id = await newSession(app);
    await send(app, runs, id, "...");
    expect(title(store, id)).toBe("New session");
    expect(renames(store, id)).toEqual([]);
  });

  it("falls back to the message when the backend shuts down mid-call", async () => {
    const { app, runs, store } = await setup(
      [reply],
      [[{ type: "wait", until: new Promise(() => {}) }]],
    );
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "The letter",
    });
    await expect.poll(() => runs.isActive(res.body.runId)).toBe(false);
    await runs.shutdown();
    expect(title(store, id)).toBe("The letter");
    expect(renames(store, id)[0]?.source).toBe("message");
  });
});

describe("auto-rename from the message", () => {
  it("cuts the message down without a model call", async () => {
    const { app, runs, store, model } = await setup([reply], [], {
      autoRenameSource: "message",
    });
    const id = await newSession(app);
    await send(app, runs, id, "  The keeper's letter.  \nSecond line");
    expect(title(store, id)).toBe("The keeper's letter");
    expect(model.title.requests).toHaveLength(0);
    expect(renames(store, id)).toEqual([
      {
        title: "The keeper's letter",
        source: "message",
        model: null,
        usage: null,
      },
    ]);
  });
});

describe("which sessions are renamed", () => {
  it("does nothing when the setting is off", async () => {
    const { app, runs, store, model } = await setup([reply], [], {
      autoRename: false,
    });
    const id = await newSession(app);
    await send(app, runs, id);
    expect(title(store, id)).toBe("New session");
    expect(model.title.requests).toHaveLength(0);
    expect(renames(store, id)).toEqual([]);
  });

  it("leaves a session with another title", async () => {
    const { app, runs, store, model } = await setup([reply], []);
    const id = await newSession(app, "Mine");
    await send(app, runs, id);
    expect(title(store, id)).toBe("Mine");
    expect(model.title.requests).toHaveLength(0);
  });

  it("renames only on the first user message", async () => {
    const { app, runs, store, model } = await setup(
      [reply, reply],
      [[{ type: "text", text: "First" }]],
    );
    const id = await newSession(app);
    await send(app, runs, id);
    expect(title(store, id)).toBe("First");
    await api(app, "PATCH", `/api/sessions/${id}`, { title: "New session" });
    await send(app, runs, id);
    expect(title(store, id)).toBe("New session");
    expect(model.title.requests).toHaveLength(1);
  });

  it("keeps a title the user set during the call", async () => {
    const hold = gate();
    const { app, runs, store } = await setup(
      [reply],
      [
        [
          { type: "wait", until: hold.until },
          { type: "text", text: "Model title" },
        ],
      ],
    );
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Go",
    });
    await expect.poll(() => runs.isActive(res.body.runId)).toBe(false);
    await api(app, "PATCH", `/api/sessions/${id}`, { title: "Mine" });
    hold.open();
    await runs.titlesSettled();
    expect(title(store, id)).toBe("Mine");
    expect(renames(store, id).map((r) => r.source)).toEqual(["user"]);
  });

  it("renames even when the first run is cancelled", async () => {
    const hold = gate();
    const { app, runs, store } = await setup(
      [[{ type: "wait", until: new Promise(() => {}) }]],
      [
        [
          { type: "wait", until: hold.until },
          { type: "text", text: "Model title" },
        ],
      ],
    );
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Go",
    });
    const runId = res.body.runId as string;
    expect((await api(app, "POST", `/api/runs/${runId}/cancel`)).status).toBe(
      200,
    );
    await expect.poll(() => runs.isActive(runId)).toBe(false);
    hold.open();
    await runs.titlesSettled();
    expect(title(store, id)).toBe("Model title");
  });
});

describe("manual rename", () => {
  it("emits session.renamed", async () => {
    const { app, store } = await setup([], []);
    const id = await newSession(app);
    await api(app, "PATCH", `/api/sessions/${id}`, { title: "Mine" });
    expect(renames(store, id)).toEqual([
      { title: "Mine", source: "user", model: null, usage: null },
    ]);
  });
});

describe("auto-rename settings", () => {
  it("has the planned defaults", async () => {
    const { app } = await setup([], []);
    const { body } = await api(app, "GET", "/api/settings");
    expect(body.effective).toMatchObject({
      autoRename: true,
      autoRenameSource: "model",
      titleModel: "",
      titlePrompt:
        "Write a short title (at most 6 words) for a writing session that starts with the user's message below. Reply with the title only.",
    });
  });

  it("refuses an empty title prompt and an unknown source", async () => {
    const { app } = await setup([], []);
    expect(
      (await api(app, "PUT", "/api/settings", { titlePrompt: "" })).status,
    ).toBe(400);
    expect(
      (await api(app, "PUT", "/api/settings", { autoRenameSource: "x" }))
        .status,
    ).toBe(400);
  });

  it("reads the environment variables, accepting only true or false", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const view = readSettings(t.db, {
      HARNESS_AUTO_RENAME: "false",
      HARNESS_AUTO_RENAME_SOURCE: "message",
      HARNESS_TITLE_MODEL: "titler",
      HARNESS_TITLE_PROMPT: "Name it.",
    });
    expect(view.effective).toMatchObject({
      autoRename: false,
      autoRenameSource: "message",
      titleModel: "titler",
      titlePrompt: "Name it.",
    });
    expect(view.overriddenByEnv.autoRename).toBe("HARNESS_AUTO_RENAME");
    expect(
      readSettings(t.db, { HARNESS_AUTO_RENAME: "true" }).effective,
    ).toMatchObject({ autoRename: true });
    expect(() => readSettings(t.db, { HARNESS_AUTO_RENAME: "yes" })).toThrow(
      /HARNESS_AUTO_RENAME=yes/,
    );
    expect(() => readSettings(t.db, { HARNESS_AUTO_RENAME: "1" })).toThrow();
  });
});
