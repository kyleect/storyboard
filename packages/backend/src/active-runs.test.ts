import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ScriptedModel, type ScriptStep } from "@harness/core";
import { allTools } from "@harness/tools";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { FileStore } from "./files-store.js";
import { RunManager, type ActiveRunSummary } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";

/* The active runs, for the activity indicators: GET /api/runs/active and `runs.changed`. */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** A tool that asks for approval before it runs. */
const risky = defineTool({
  name: "risky",
  description: "Asks first.",
  input: z.object({ text: z.string() }),
  approval: "ask",
  group: "utilities",
  alwaysOn: false,
  execute: () => ({ data: { ok: true } }),
});

async function setup(scripts: ScriptStep[][]) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const files = new FileStore(t.db);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel(scripts);
  // One AppEvents for the manager (which publishes) and the server (which
  // streams), as in main.ts.
  const events = new AppEvents();
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [risky, ...allTools],
    agents,
    files,
    systemPrompt: () => "BASE",
    events,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    files,
    events,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  const changes: { sessionId: string; runId: string }[] = [];
  const stop = events.subscribe((e: AppEvent) => {
    if (e.type === "runs.changed") changes.push(e.data);
  });
  cleanups.push(t.cleanup, () => app.close(), stop);
  return { store, agents, runs, app, changes, scripts };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  token: string | null = TOKEN,
) {
  const res = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: (res.body === "" ? undefined : JSON.parse(res.body)) as Record<
      string,
      unknown
    >,
  };
}

const active = async (app: FastifyInstance) =>
  (await api(app, "GET", "/api/runs/active")).body.runs as ActiveRunSummary[];

const call = (callId: string, name: string, args: object = {}): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});

const agentInput = (name: string, over: Partial<AgentInput> = {}) => ({
  name,
  description: `${name} agent`,
  prompt: `You are ${name}.`,
  toolGrant: grant("deny", []),
  toolApproval: {},
  ...over,
});

async function newSession(c: Ctx, agentId: string | null = null) {
  const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
  const id = body.id as string;
  if (agentId) c.store.setSessionChoices(id, { agentId });
  return id;
}

async function send(c: Ctx, sessionId: string) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content: "Go",
  });
  expect(res.status).toBe(202);
  return res.body.runId as string;
}

/** Answers every approval that opens, in any run of the session, until `done`. */
async function answerUntil(c: Ctx, sessionId: string, done: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    const live = c.runs.snapshot(sessionId);
    for (const run of [
      ...(live.activeRun ? [live.activeRun] : []),
      ...live.childRuns,
    ]) {
      const open = run.approvals[0];
      if (open) {
        c.runs.answerApproval(run.runId, open.requestId, { choice: "once" });
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const idle = (c: Ctx) => expect.poll(() => c.runs.activeRuns().length);

describe("GET /api/runs/active", () => {
  it("is empty when nothing runs, and needs the token", async () => {
    const c = await setup([]);
    expect(await active(c.app)).toEqual([]);
    expect(
      (await api(c.app, "GET", "/api/runs/active", undefined, null)).status,
    ).toBe(401);
  });

  it("lists a run in progress and announces its start and end", async () => {
    const c = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const sessionId = await newSession(c);
    const runId = await send(c, sessionId);

    expect(await active(c.app)).toEqual([
      {
        runId,
        sessionId,
        sessionTitle: c.store.getSession(sessionId)?.title,
        parentRunId: null,
        agentName: null,
        waiting: false,
      },
    ]);
    // Published after the run was registered, so a refetch already sees it.
    expect(c.changes).toEqual([{ sessionId, runId }]);

    await api(c.app, "POST", `/api/runs/${runId}/cancel`);
    await idle(c).toBe(0);
    expect(await active(c.app)).toEqual([]);
    // Published after the run was removed: the last event is the end.
    expect(c.changes.at(-1)).toEqual({ sessionId, runId });
    expect(c.changes.length).toBeGreaterThanOrEqual(2);
  });

  it("reaches a window over the app stream", async () => {
    const c = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    await c.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = c.app.server.address() as { port: number };
    const abort = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/events?token=${TOKEN}`,
      { signal: abort.signal },
    );
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const sessionId = await newSession(c);
    const runId = await send(c, sessionId);
    const decoder = new TextDecoder();
    let received = "";
    while (reader && !received.includes("runs.changed")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    expect(received).toContain('"type":"runs.changed"');
    expect(received).toContain(runId);

    abort.abort();
    await api(c.app, "POST", `/api/runs/${runId}/cancel`);
    await idle(c).toBe(0);
  });

  it("marks a run waiting while it asks for approval", async () => {
    const c = await setup([
      [call("c1", "risky", { text: "a" })],
      [{ type: "text", text: "Done" }],
    ]);
    const agent = c.agents.create(
      null,
      agentInput("Editor", { toolGrant: grant("allow", ["risky"]) }),
    );
    const sessionId = await newSession(c, agent.id);
    const runId = await send(c, sessionId);

    await expect.poll(async () => (await active(c.app))[0]?.waiting).toBe(true);
    expect((await active(c.app))[0]).toMatchObject({
      runId,
      agentName: "Editor",
    });
    // Besides the start, the window was told when the wait began.
    expect(c.changes.length).toBeGreaterThanOrEqual(2);
    const before = c.changes.length;

    const open = c.runs.snapshot(sessionId).activeRun?.approvals[0];
    expect(open).toBeDefined();
    c.runs.answerApproval(runId, open?.requestId ?? "", { choice: "once" });

    // Answering tells the windows, and the run no longer waits.
    expect(c.changes.length).toBeGreaterThan(before);
    expect(c.runs.activeRuns().some((r) => r.waiting)).toBe(false);
    await idle(c).toBe(0);
  });

  it("lists a subagent's run under the run that started it", async () => {
    // The parent starts the subagent; the subagent then waits, so both are
    // in progress at once.
    const c = await setup([
      [],
      [
        { type: "text", text: "Working" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const boss = c.agents.create(
      null,
      agentInput("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const editor = c.agents.create(
      null,
      agentInput("Editor", { subagent: true }),
    );
    c.scripts[0] = [
      call("p1", "start_subagent", { agentId: editor.id, task: "Edit." }),
    ];
    const sessionId = await newSession(c, boss.id);
    const runId = await send(c, sessionId);

    // start_subagent may ask first; answer it so the child can start.
    await answerUntil(c, sessionId, () => c.runs.activeRuns().length === 2);

    const runs = await active(c.app);
    expect(runs).toHaveLength(2);
    const parent = runs.find((r) => r.runId === runId);
    const child = runs.find((r) => r.runId !== runId);
    expect(parent).toMatchObject({ parentRunId: null, agentName: "Boss" });
    expect(child).toMatchObject({
      parentRunId: runId,
      agentName: "Editor",
      sessionId,
    });

    // Cancelling the parent ends the child with it.
    await api(c.app, "POST", `/api/runs/${runId}/cancel`);
    await idle(c).toBe(0);
  });
});
