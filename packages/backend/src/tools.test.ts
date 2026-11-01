import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  LlamaServerAdapter,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type StoredEvent,
  type Tool,
} from "@harness/core";
import { chatChunk, DONE, FakeLlamaServer } from "@harness/core/testing";
import { allTools } from "@harness/tools";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS, readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** Records its calls. `ask` makes it ask before running by default. */
function recorder(name: string, approval: "ask" | "never") {
  const calls: string[] = [];
  const tool = defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({ text: z.string() }),
    approval,
    execute: (input) => {
      calls.push(input.text);
      return { data: { got: input.text } };
    },
  });
  return { tool, calls };
}

async function setup(
  scripts: ScriptStep[][],
  tools: Tool[],
  env: NodeJS.ProcessEnv = {},
) {
  const t = tempDatabase();
  const store = new Store(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => readSettings(t.db, env).effective,
    model: () => model,
    tools,
  });
  const app = buildServer({ store, runs, token: TOKEN, env });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model };
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
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

async function newSession(app: FastifyInstance) {
  const { body } = await api(app, "POST", "/api/sessions", { title: "T" });
  return (body as { id: string }).id;
}

async function send(app: FastifyInstance, sessionId: string, content = "Hi") {
  const { body } = await api(
    app,
    "POST",
    `/api/sessions/${sessionId}/messages`,
    {
      content,
    },
  );
  return (body as { runId: string }).runId;
}

async function waitIdle(runs: RunManager, runId: string) {
  await expect.poll(() => runs.isActive(runId)).toBe(false);
}

const call = (text: string, name = "rec"): ScriptStep => ({
  type: "tool_call",
  callId: `call-${text}`,
  name,
  arguments: JSON.stringify({ text }),
});
const answer: ScriptStep[] = [{ type: "text", text: "Done" }];

interface Detail {
  messages: {
    id: string;
    message: { role: string } & Record<string, unknown>;
  }[];
  activeRun: {
    runId: string;
    message: unknown;
    approvals: { requestId: string; name: string; arguments: unknown }[];
  } | null;
}

const detail = async (app: FastifyInstance, id: string) =>
  (await api(app, "GET", `/api/sessions/${id}`)).body as Detail;

/** Waits until the session's active run has an open approval request. */
async function openApproval(app: FastifyInstance, id: string) {
  await expect
    .poll(async () => (await detail(app, id)).activeRun?.approvals.length)
    .toBe(1);
  const run = (await detail(app, id)).activeRun;
  if (!run) throw new Error("no active run");
  const approval = run.approvals[0];
  if (!approval) throw new Error("no approval");
  return { runId: run.runId, approval };
}

const roles = (d: Detail) => d.messages.map((m) => m.message.role);

describe("a run with tools", () => {
  it("runs the tool, stores every message, and links them to the run", async () => {
    const rec = recorder("rec", "never");
    const { app, runs, store, model } = await setup(
      [[call("a")], answer],
      [rec.tool],
    );
    const id = await newSession(app);
    const runId = await send(app, id);
    await waitIdle(runs, runId);

    expect(rec.calls).toEqual(["a"]);
    const d = await detail(app, id);
    expect(roles(d)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(d.messages[2]?.message).toEqual({
      role: "tool",
      callId: "call-a",
      name: "rec",
      content: '{"got":"a"}',
      isError: false,
      data: { got: "a" },
    });
    expect(store.runMessageIds(runId)).toEqual(
      d.messages.slice(1).map((m) => m.id),
    );
    expect(store.getRun(runId)).toMatchObject({
      kind: "loop",
      status: "finished",
    });
    expect((model.requests[0] as ChatRequest).tools).toEqual([
      {
        name: "rec",
        description: "The rec tool.",
        inputSchema: rec.tool.inputSchema,
      },
    ]);
  });

  it("stops at the loop limit from Settings, then continues from the tool result", async () => {
    const rec = recorder("rec", "never");
    const { app, runs, t, model } = await setup(
      [[call("a")], [call("b")], answer],
      [rec.tool],
    );
    writeSettings(t.db, { loopLimit: 2 });
    const id = await newSession(app);
    const runId = await send(app, id);
    await waitIdle(runs, runId);
    expect(rec.calls).toEqual(["a", "b"]);
    expect(model.requests).toHaveLength(2);
    expect(roles(await detail(app, id)).at(-1)).toBe("tool");

    // Continue after a tool result starts the next step.
    const cont = await api(app, "POST", `/api/sessions/${id}/continue`);
    expect(cont.status).toBe(202);
    await waitIdle(runs, (cont.body as { runId: string }).runId);
    expect(roles(await detail(app, id)).at(-1)).toBe("assistant");
    expect((model.requests[2] as ChatRequest).messages.at(-1)?.role).toBe(
      "tool",
    );
  });

  it("reads the loop limit from HARNESS_LOOP_LIMIT", async () => {
    const { t } = await setup([], []);
    expect(readSettings(t.db, {}).effective.loopLimit).toBe(DEFAULTS.loopLimit);
    expect(
      readSettings(t.db, { HARNESS_LOOP_LIMIT: "7" }).effective.loopLimit,
    ).toBe(7);
    expect(() => readSettings(t.db, { HARNESS_LOOP_LIMIT: "0" })).toThrow(
      /HARNESS_LOOP_LIMIT/,
    );
  });

  it("refuses to continue a message that contains tool calls", async () => {
    const { app, store } = await setup([], []);
    const id = await newSession(app);
    store.addMessage(
      id,
      "m",
      {
        role: "assistant",
        content: [{ type: "tool_call", callId: "c", name: "x", arguments: {} }],
      },
      "T",
    );
    const res = await api(app, "POST", `/api/sessions/${id}/continue`);
    expect(res.status).toBe(409);
  });
});

describe("approval", () => {
  it("waits with no UI attached, shows the request in the snapshot, and runs once allowed", async () => {
    const rec = recorder("rec", "ask");
    const { app, runs } = await setup([[call("a")], answer], [rec.tool]);
    const id = await newSession(app);
    const runId = await send(app, id);

    const { approval } = await openApproval(app, id);
    expect(approval).toMatchObject({
      name: "rec",
      callId: "call-a",
      arguments: { text: "a" },
    });
    // Still waiting a while later: nobody has answered.
    await new Promise((r) => setTimeout(r, 100));
    expect(runs.isActive(runId)).toBe(true);
    expect(rec.calls).toEqual([]);

    const res = await api(
      app,
      "POST",
      `/api/runs/${runId}/approvals/${approval.requestId}`,
      { choice: "once" },
    );
    expect(res).toEqual({ status: 200, body: { ok: true } });
    await waitIdle(runs, runId);
    expect(rec.calls).toEqual(["a"]);
  });

  it("returns a denied call to the model and finishes the run", async () => {
    const rec = recorder("rec", "ask");
    const { app, runs, store } = await setup([[call("a")], answer], [rec.tool]);
    const id = await newSession(app);
    const runId = await send(app, id);
    const { approval } = await openApproval(app, id);
    await api(
      app,
      "POST",
      `/api/runs/${runId}/approvals/${approval.requestId}`,
      {
        choice: "deny",
      },
    );
    await waitIdle(runs, runId);
    expect(rec.calls).toEqual([]);
    const d = await detail(app, id);
    expect(d.messages[2]?.message).toMatchObject({
      isError: true,
      content: "The user denied this tool call.",
    });
    expect(store.getRun(runId)?.status).toBe("finished");
    const resolved = store
      .runEvents(runId)
      .find((e) => e.type === "tool.approval_resolved");
    expect(resolved?.data).toEqual({
      requestId: approval.requestId,
      choice: "deny",
    });
  });

  it('"Allow for this session" stops asking in that session only', async () => {
    const rec = recorder("rec", "ask");
    const { app, runs } = await setup(
      [[call("a")], answer, [call("b")], answer, [call("c")], answer],
      [rec.tool],
    );
    const id = await newSession(app);
    const first = await send(app, id);
    const { approval } = await openApproval(app, id);
    await api(
      app,
      "POST",
      `/api/runs/${first}/approvals/${approval.requestId}`,
      {
        choice: "session",
      },
    );
    await waitIdle(runs, first);

    const second = await send(app, id, "again");
    await waitIdle(runs, second);
    expect(rec.calls).toEqual(["a", "b"]);

    // Another session still asks.
    const other = await newSession(app);
    const third = await send(app, other);
    await openApproval(app, other);
    runs.cancel(third);
    await waitIdle(runs, third);
  });

  it('"Always allow this tool" switches asking off in Settings', async () => {
    const rec = recorder("rec", "ask");
    const { app, runs } = await setup(
      [[call("a")], answer, [call("b")], answer],
      [rec.tool],
    );
    const id = await newSession(app);
    const first = await send(app, id);
    const { approval } = await openApproval(app, id);
    await api(
      app,
      "POST",
      `/api/runs/${first}/approvals/${approval.requestId}`,
      {
        choice: "always",
      },
    );
    await waitIdle(runs, first);

    expect((await api(app, "GET", "/api/tools")).body).toEqual([
      {
        name: "rec",
        description: "The rec tool.",
        askByDefault: true,
        ask: false,
      },
    ]);
    const other = await newSession(app);
    await waitIdle(runs, await send(app, other));
    expect(rec.calls).toEqual(["a", "b"]);
  });

  it("rejects answers to unknown requests, inactive runs and bad choices", async () => {
    const rec = recorder("rec", "ask");
    const { app, runs } = await setup([[call("a")], answer], [rec.tool]);
    const id = await newSession(app);
    const runId = await send(app, id);
    const { approval } = await openApproval(app, id);
    const url = `/api/runs/${runId}/approvals`;

    expect(
      (await api(app, "POST", `${url}/nope`, { choice: "once" })).status,
    ).toBe(404);
    expect(
      (
        await api(app, "POST", `${url}/${approval.requestId}`, {
          choice: "maybe",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(app, "POST", `/api/runs/none/approvals/x`, { choice: "once" }))
        .status,
    ).toBe(404);

    runs.cancel(runId);
    await waitIdle(runs, runId);
    expect(
      (
        await api(app, "POST", `${url}/${approval.requestId}`, {
          choice: "once",
        })
      ).status,
    ).toBe(409);
  });

  it("withdraws the request when the run is cancelled", async () => {
    const rec = recorder("rec", "ask");
    const { app, runs, store } = await setup([[call("a")]], [rec.tool]);
    const id = await newSession(app);
    const runId = await send(app, id);
    const { approval } = await openApproval(app, id);
    await api(app, "POST", `/api/runs/${runId}/cancel`);
    await waitIdle(runs, runId);

    const events = store.runEvents(runId);
    expect(events.find((e) => e.type === "request.cancel")?.data).toMatchObject(
      {
        requestId: approval.requestId,
      },
    );
    expect(store.getRun(runId)?.status).toBe("cancelled");
    expect((await detail(app, id)).messages.at(-1)?.message).toMatchObject({
      role: "tool",
      content: "Not run: the run was cancelled.",
    });
  });

  it("ends a run waiting for approval as interrupted on shutdown", async () => {
    const rec = recorder("rec", "ask");
    const { app, runs, store } = await setup([[call("a")]], [rec.tool]);
    const id = await newSession(app);
    const runId = await send(app, id);
    await openApproval(app, id);
    await runs.shutdown();

    expect(store.getRun(runId)?.status).toBe("interrupted");
    expect(store.runEvents(runId).at(-1)?.type).toBe("run.interrupted");
    expect(store.listMessages(id).at(-1)?.message).toMatchObject({
      role: "tool",
      content: "Not run: the backend was stopped.",
    });
  });
});

describe("tool settings", () => {
  it("lists tools and switches asking either way", async () => {
    const asks = recorder("asks", "ask");
    const quiet = recorder("quiet", "never");
    const { app } = await setup([], [asks.tool, quiet.tool]);
    const list = async () => (await api(app, "GET", "/api/tools")).body;

    expect(await list()).toEqual([
      {
        name: "asks",
        description: "The asks tool.",
        askByDefault: true,
        ask: true,
      },
      {
        name: "quiet",
        description: "The quiet tool.",
        askByDefault: false,
        ask: false,
      },
    ]);
    expect(
      (await api(app, "PUT", "/api/tools/quiet/approval", { ask: true })).body,
    ).toMatchObject({ name: "quiet", ask: true });
    await api(app, "PUT", "/api/tools/asks/approval", { ask: false });
    expect(await list()).toMatchObject([{ ask: false }, { ask: true }]);

    // Back to the default.
    await api(app, "PUT", "/api/tools/asks/approval", { ask: true });
    expect(await list()).toMatchObject([{ ask: true }, { ask: true }]);

    expect(
      (await api(app, "PUT", "/api/tools/nope/approval", { ask: true })).status,
    ).toBe(404);
    expect(
      (await api(app, "PUT", "/api/tools/asks/approval", { ask: "yes" }))
        .status,
    ).toBe(400);
  });

  it("asks before a tool that runs freely by default once Settings says so", async () => {
    const quiet = recorder("quiet", "never");
    const { app, runs } = await setup([[call("a", "quiet")]], [quiet.tool]);
    await api(app, "PUT", "/api/tools/quiet/approval", { ask: true });
    const id = await newSession(app);
    const runId = await send(app, id);
    await openApproval(app, id);
    expect(quiet.calls).toEqual([]);
    runs.cancel(runId);
    await waitIdle(runs, runId);
  });
});

describe("recovery after a crash", () => {
  it("records interrupted results for unanswered calls and withdraws open requests", async () => {
    const { t, store } = await setup([], []);
    store.createSession("s1", "S", "T");
    store.addMessage("s1", "u1", { role: "user", content: "Hi" }, "T");
    store.createRun({ id: "r1", sessionId: "s1", kind: "loop", now: "T" });
    // Step 1 finished and was saved; the backend died waiting for approval.
    const finishedMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "tool_call" as const,
          callId: "c1",
          name: "rec",
          arguments: {},
        },
      ],
    };
    store.addMessage("s1", "m1", finishedMessage, "T");
    store.linkRunMessage("r1", "m1");
    const base = { runId: "r1", sessionId: "s1", time: "T" };
    store.insertEvent({ ...base, type: "run.started", data: { kind: "loop" } });
    store.insertEvent({
      ...base,
      type: "message.started",
      data: { messageId: "m1", role: "assistant" },
    });
    store.insertEvent({
      ...base,
      type: "message.finished",
      data: {
        messageId: "m1",
        message: finishedMessage,
        finishReason: "tool_calls",
      },
    });
    store.insertEvent({
      ...base,
      type: "tool.approval_requested",
      data: { requestId: "q1", callId: "c1", name: "rec", arguments: {} },
    });

    const fresh = new RunManager({
      store: new Store(t.db),
      settings: () => DEFAULTS,
      model: () => new ScriptedModel([]),
    });
    expect(fresh.recover()).toEqual(["r1"]);

    expect(store.getRun("r1")?.status).toBe("interrupted");
    const messages = store.listMessages("s1").map((m) => m.message);
    expect(messages.at(-1)).toEqual({
      role: "tool",
      callId: "c1",
      name: "rec",
      content: "Interrupted: the backend stopped before this call finished.",
      isError: true,
    });
    expect(store.runMessageIds("r1")).toHaveLength(2);
    const types = store.runEvents("r1").map((e: StoredEvent) => e.type);
    expect(types.slice(-3)).toEqual([
      "request.cancel",
      "tool.result",
      "run.interrupted",
    ]);
  });

  it("saves a partial message's calls and answers them", async () => {
    const { t, store } = await setup([], []);
    store.createSession("s1", "S", "T");
    store.createRun({ id: "r1", sessionId: "s1", kind: "loop", now: "T" });
    const base = { runId: "r1", sessionId: "s1", time: "T" };
    store.insertEvent({
      ...base,
      type: "message.started",
      data: { messageId: "m1", role: "assistant" },
    });
    store.insertEvent({
      ...base,
      type: "tool.called",
      data: {
        messageId: "m1",
        contentIndex: 0,
        callId: "c1",
        name: "rec",
        arguments: {},
      },
    });

    new RunManager({
      store: new Store(t.db),
      settings: () => DEFAULTS,
      model: () => new ScriptedModel([]),
    }).recover();

    expect(store.listMessages("s1").map((m) => m.message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(store.runMessageIds("r1")[0]).toBe("m1");
  });
});

describe("with llama-server's wire format", () => {
  it("runs current_date and sends the call and its result back", async () => {
    const llama = new FakeLlamaServer();
    const llamaUrl = await llama.start();
    llama.reply(
      {
        frames: [
          chatChunk({ role: "assistant", content: null }),
          chatChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "current_date", arguments: "{}" },
              },
            ],
          }),
          chatChunk({}, "tool_calls"),
          DONE,
        ],
      },
      {
        frames: [
          chatChunk({ content: "It is today." }),
          chatChunk({}, "stop"),
          DONE,
        ],
      },
    );
    const t = tempDatabase();
    const store = new Store(t.db);
    const runs = new RunManager({
      store,
      settings: () => ({ ...DEFAULTS, llamaServerUrl: llamaUrl }),
      model: (s) => new LlamaServerAdapter({ baseUrl: s.llamaServerUrl }),
      tools: allTools,
    });
    const app = buildServer({ store, runs, token: TOKEN, env: {} });
    cleanups.push(
      t.cleanup,
      () => app.close(),
      () => llama.stop(),
    );

    const id = await newSession(app);
    await waitIdle(runs, await send(app, id, "What day is it?"));

    const first = llama.requests[0]?.body as {
      tools: { function: { name: string; parameters: unknown } }[];
    };
    expect(first.tools.map((x) => x.function.name)).toEqual(
      allTools.map((t) => t.name),
    );
    expect(first.tools[0]?.function.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const second = llama.requests[1]?.body as {
      messages: Record<string, unknown>[];
    };
    expect(second.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "current_date", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: expect.stringMatching(
          /^\{"date":"\d{4}-\d{2}-\d{2}","timeZone":".+"\}$/,
        ) as unknown,
      },
    ]);
    expect(roles(await detail(app, id))).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});
