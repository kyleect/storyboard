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

/* GET /api/sessions-unread/list: which sessions have a reply not yet seen. */

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

async function api(
  app: FastifyInstance,
  method: "GET" | "POST",
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

const unreadIds = async (app: FastifyInstance) =>
  (
    (await api(app, "GET", "/api/sessions-unread/list")).body.sessions as {
      id: string;
    }[]
  ).map((s) => s.id);

/** A session whose latest message is the assistant's reply. */
function replied(store: Store, id: string, now: string, projectId?: string) {
  store.createSession(id, id, now, projectId ?? null);
  store.addMessage(id, `${id}-q`, user("hi"), now);
  store.addMessage(id, `${id}-a`, asst("hello"), now);
}

describe("GET /api/sessions-unread/list", () => {
  it("lists the sessions with a reply not yet seen, in any project, newest first", async () => {
    const { app, store } = setup();
    const project = (await api(app, "POST", "/api/projects", { name: "P" }))
      .body.id as string;
    replied(store, "a", "T0");
    // Only the user has spoken: nothing new.
    store.createSession("b", "b", "T1");
    store.addMessage("b", "b-q", user("hi"), "T1");
    replied(store, "c", "T3", project);

    expect(await unreadIds(app)).toEqual(["c", "a"]);
  });

  it("drops a session once it is seen", async () => {
    const { app, store } = setup();
    replied(store, "a", "T0");
    replied(store, "c", "T3");

    await api(app, "POST", "/api/sessions/a/seen");

    expect(await unreadIds(app)).toEqual(["c"]);
  });

  it("leaves out sessions in the trash", async () => {
    const { app, store } = setup();
    replied(store, "a", "T0");
    store.db
      .prepare("UPDATE sessions SET trashed_at = 'T' WHERE id = 'a'")
      .run();

    expect(await unreadIds(app)).toEqual([]);
  });
});
