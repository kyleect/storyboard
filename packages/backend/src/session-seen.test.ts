import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, type Message } from "@harness/core";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/* POST /api/sessions/:id/seen: the user has seen the latest message. */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const agents = new AgentStore(t.db);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => new ScriptedModel([]),
    tools: [],
    agents,
    systemPrompt: () => "BASE",
  });
  const app = buildServer({
    store,
    runs,
    agents,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
  });
  cleanups.push(t.cleanup, () => app.close());
  return { store, app };
}

async function api(app: FastifyInstance, method: "GET" | "POST", url: string) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return {
    status: res.statusCode,
    body: (res.body === "" ? undefined : JSON.parse(res.body)) as Record<
      string,
      unknown
    >,
  };
}

const user = (content: string): Message => ({ role: "user", content });
const asst = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** What the chats tree reads: the standalone sessions' `unread`. */
async function unread(app: FastifyInstance, id: string) {
  const list = (await api(app, "GET", "/api/sessions")).body as unknown as {
    id: string;
    unread: boolean;
  }[];
  return list.find((s) => s.id === id)?.unread;
}

describe("POST /api/sessions/:id/seen", () => {
  it("answers 404 for a session that does not exist", async () => {
    const { app } = setup();
    const res = await api(app, "POST", "/api/sessions/nope/seen");
    expect(res.status).toBe(404);
  });

  it("clears unread and returns the session", async () => {
    const { app, store } = setup();
    store.createSession("s", "Session", "T0");
    store.addMessage("s", "u1", user("hi"), "T1");
    store.addMessage("s", "a1", asst("hello"), "T2");
    expect(await unread(app, "s")).toBe(true);

    const res = await api(app, "POST", "/api/sessions/s/seen");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "s", seen_tip_id: "a1" });
    expect(await unread(app, "s")).toBe(false);
  });

  it("can be called again without changing anything", async () => {
    const { app, store } = setup();
    store.createSession("s", "Session", "T0");
    store.addMessage("s", "u1", user("hi"), "T1");
    store.addMessage("s", "a1", asst("hello"), "T2");

    const first = await api(app, "POST", "/api/sessions/s/seen");
    const second = await api(app, "POST", "/api/sessions/s/seen");

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
