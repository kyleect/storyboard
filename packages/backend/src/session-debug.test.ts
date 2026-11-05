import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ScriptStep,
  type StoredEvent,
  type Tool,
} from "@harness/core";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import type { SessionDebug } from "./session-debug.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* The session debugging export (GET /api/sessions/:id/debug). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const echo = defineTool({
  name: "echo",
  description: "Echoes its input.",
  input: z.object({ text: z.string() }),
  approval: "never",
  execute: ({ text }) => ({ data: text }),
});
const TOOLS: Tool[] = [echo];

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

async function setup(scripts: ScriptStep[][], systemPrompt = "Be brief.") {
  const t = tempDatabase();
  writeSettings(t.db, { systemPrompt });
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
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model };
}

async function api(app: FastifyInstance, url: string, authorized = true) {
  const res = await app.inject({
    method: "GET",
    url,
    ...(authorized ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

async function runSession(app: FastifyInstance, runs: RunManager) {
  const created = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {},
  });
  const sessionId = (created.json() as { id: string }).id;
  const sent = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { content: "Say hi" },
  });
  const runId = (sent.json() as { runId: string }).runId;
  await expect.poll(() => runs.isActive(runId)).toBe(false);
  return { sessionId, runId };
}

describe("session debug export", () => {
  it("holds the composed system prompt, tools, transcript and events", async () => {
    const s = await setup([
      [
        {
          type: "tool_call",
          callId: "c1",
          name: "echo",
          arguments: JSON.stringify({ text: "x" }),
        },
      ],
      [{ type: "text", text: "Hello" }],
    ]);
    const { sessionId, runId } = await runSession(s.app, s.runs);

    const res = await api(s.app, `/api/sessions/${sessionId}/debug`);
    expect(res.status).toBe(200);
    const debug = res.body as SessionDebug;

    expect(debug.format).toBe(1);
    expect(debug.session.id).toBe(sessionId);
    expect(debug.runs).toHaveLength(1);
    const run = debug.runs[0];
    if (!run) throw new Error("no run in the export");
    expect(run.id).toBe(runId);
    expect(run.request).toBe("recorded");
    expect(run.systemPrompt).toBe("Be brief.");
    expect(run.tools?.map((t) => t.name)).toEqual(["echo"]);
    expect(run.tools?.[0]?.inputSchema).toMatchObject({ type: "object" });

    // The user's message, the tool call, its result and the reply.
    expect(debug.messages.map((m) => m.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    // Each message says when it was made, so the transcript can be laid out
    // in time with the events.
    for (const m of debug.messages) expect(typeof m.createdAt).toBe("string");

    // Every event, in order, deltas and tool events included.
    const types = debug.events.map((e: StoredEvent) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.result");
    expect(types).toContain("text.delta");
    expect(types.at(-1)).toBe("run.finished");
    const ids = debug.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("marks a run whose request was not recorded", async () => {
    const s = await setup([]);
    const session = s.store.createSession("old-session", "Old", now());
    // As a run made before the migration: no prompt and no tools kept.
    s.store.createRun({
      id: "old-run",
      sessionId: session.id,
      kind: "loop",
      now: now(),
    });

    const debug = (await api(s.app, `/api/sessions/${session.id}/debug`))
      .body as SessionDebug;
    expect(debug.runs).toHaveLength(1);
    expect(debug.runs[0]).toMatchObject({
      id: "old-run",
      request: "not_recorded",
      systemPrompt: null,
      tools: null,
    });
  });

  it("is a 404 for an unknown session and needs the token", async () => {
    const s = await setup([]);
    expect((await api(s.app, "/api/sessions/nope/debug")).status).toBe(404);
    expect((await api(s.app, "/api/sessions/nope/debug", false)).status).toBe(
      401,
    );
  });
});
