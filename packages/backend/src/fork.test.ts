import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type Message,
  type ScriptStep,
  type StoredEvent,
} from "@harness/core";
import { AppEvents } from "./app-events.js";
import { EventBody } from "@harness/core";
import { MESSAGE_ID_KEYS, RUN_ID_KEYS } from "./fork.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store, type StoredMessage } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/* Forking a session (message editing plan, part D). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const say = (text: string): ScriptStep[] => [
  { type: "text", text },
  { type: "finish", reason: "stop" },
];

async function setup(
  scripts: ScriptStep[][] = [],
  settings: Record<string, unknown> = {},
) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [],
    systemPrompt: () => "BASE",
    now,
  });
  const app = buildServer({
    store,
    runs,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  const events: StoredEvent[] = [];
  const watch = (sessionId: string) => {
    const off = runs.subscribe(sessionId, (e) => events.push(e));
    cleanups.push(off);
  };
  return { t, store, runs, app, model, events, watch };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
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
    > &
      Record<number, unknown>,
  };
}

async function newSession(c: Setup) {
  const { body } = await api(c.app, "POST", "/api/sessions", {});
  const id = body.id as string;
  c.watch(id);
  return id;
}

async function settle(c: Setup, runId: unknown) {
  await expect.poll(() => c.runs.isActive(runId as string)).toBe(false);
}

/** Sends a message and waits for the reply. */
async function send(c: Setup, id: string, content: string) {
  const res = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
    content,
  });
  expect(res.status).toBe(202);
  await settle(c, res.body.runId);
}

interface View {
  messages: (StoredMessage & { message: Message })[];
  branching: {
    points: string[];
    editable: string[];
    regenerate: string | null;
    continuations: { id: string; role: string; preview: string }[];
  };
  session: { tip_id: string | null };
}

async function view(c: Setup, id: string): Promise<View> {
  const { body } = await api(c.app, "GET", `/api/sessions/${id}`);
  return body as unknown as View;
}

const text = (m: StoredMessage): string => {
  const message = m.message;
  if (message.role === "user") return message.content;
  if (message.role === "assistant")
    return message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
  return "";
};

const texts = async (c: Setup, id: string) =>
  (await view(c, id)).messages.map(text);

const fork = (c: Setup, id: string, messageId: string, title = "Copy") =>
  api(c.app, "POST", `/api/sessions/${id}/fork`, { messageId, title });

const allMessages = (c: Setup, id: string) => c.store.listMessages(id, "all");

describe("POST /api/sessions/:id/fork", () => {
  it("copies the line up to the message into a new session", async () => {
    const c = await setup([say("a1"), say("a2")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const [q1, a1] = (await view(c, id)).messages as StoredMessage[];
    c.store.setSessionChoices(id, { model: "m1" });

    const res = await fork(c, id, a1?.id ?? "", "Fork of it");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Fork of it",
      model: "m1",
      forked_from_id: id,
      forked_from_title: "New session",
    });
    const forkId = res.body.id as string;

    // Only what came before and at the message, with new ids.
    const copy = await view(c, forkId);
    expect(copy.messages.map(text)).toEqual(["q1", "a1"]);
    expect(copy.messages.map((m) => m.id)).not.toContain(q1?.id);
    expect(copy.session.tip_id).toBe(copy.messages[1]?.id);
    expect(copy.messages[1]?.parentId).toBe(copy.messages[0]?.id);
    // The source is untouched.
    expect(await texts(c, id)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("keeps the project and the agent", async () => {
    const c = await setup([say("a1")]);
    const project = (
      await api(c.app, "POST", "/api/projects", { name: "P", description: "" })
    ).body.id as string;
    const created = await api(c.app, "POST", "/api/sessions", {
      projectId: project,
    });
    const id = created.body.id as string;
    c.watch(id);
    await send(c, id, "q1");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const res = await fork(c, id, reply.id);
    expect(res.body.project_id).toBe(project);
    expect(res.body.agent_id).toBe(created.body.agent_id);
  });

  it("copies branches that leave the line before the message, not after", async () => {
    const c = await setup([
      say("a1"),
      say("a2"),
      say("a1 again"),
      say("a2 again"),
    ]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const first = (await view(c, id)).messages[0] as StoredMessage;
    // Edit q1 as a branch: q1 now has two versions, the new one shown.
    const edit = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "q1 v2" },
    );
    await settle(c, edit.body.runId);
    await send(c, id, "q2 v2");
    const line = (await view(c, id)).messages as StoredMessage[];
    expect(line.map(text)).toEqual(["q1 v2", "a1 again", "q2 v2", "a2 again"]);

    // Fork at the first reply: the other q1 is a branch leaving the root.
    const res = await fork(c, id, line[1]?.id ?? "");
    const copy = await view(c, res.body.id as string);
    expect(copy.messages.map(text)).toEqual(["q1 v2", "a1 again"]);
    const shown = copy.messages[0] as StoredMessage;
    expect(shown.branches?.ids).toHaveLength(2);
    // Switching to the old version in the copy shows its whole subtree.
    const old = shown.branches?.ids[0] ?? "";
    await api(c.app, "POST", `/api/sessions/${res.body.id}/switch`, {
      messageId: old,
    });
    expect((await texts(c, res.body.id as string))[0]).toBe("q1");

    // A fork late in the line has the middle branch point too.
    const late = await fork(c, id, line[3]?.id ?? "");
    const lateCopy = await view(c, late.body.id as string);
    expect(lateCopy.messages.map(text)).toEqual([
      "q1 v2",
      "a1 again",
      "q2 v2",
      "a2 again",
    ]);
    expect(lateCopy.messages[0]?.branches?.ids).toHaveLength(2);
  });

  it("does not copy deleted branches", async () => {
    const c = await setup([say("a1"), say("a1 again")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    const first = (await view(c, id)).messages[0] as StoredMessage;
    const edit = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "q1 v2" },
    );
    await settle(c, edit.body.runId);
    // Delete the old version.
    const del = await api(
      c.app,
      "DELETE",
      `/api/sessions/${id}/branches/${first.id}`,
    );
    expect(del.status).toBe(200);
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const res = await fork(c, id, reply.id);
    const copy = await view(c, res.body.id as string);
    expect(copy.messages[0]?.branches).toBeNull();
    expect(allMessages(c, res.body.id as string)).toHaveLength(2);
  });

  it("copies runs and events with the ids rewritten", async () => {
    const c = await setup([say("a1"), say("a2")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const res = await fork(c, id, reply.id);
    const forkId = res.body.id as string;

    const copyRuns = c.store.listRuns(forkId);
    expect(copyRuns).toHaveLength(1);
    const sourceRuns = c.store.listRuns(id).map((r) => r.id);
    expect(sourceRuns).toHaveLength(2);
    expect(sourceRuns).not.toContain(copyRuns[0]?.id);

    const owned = new Set(allMessages(c, forkId).map((m) => m.id));
    const events = c.store.eventsAfter(forkId, 0);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.runId).toBe(copyRuns[0]?.id);
      const messageId = (e.data as { messageId?: string }).messageId;
      if (messageId !== undefined) expect(owned.has(messageId)).toBe(true);
    }
    // The source keeps all of its own.
    expect(c.store.eventsAfter(id, 0).length).toBeGreaterThan(events.length);
    // A run that wrote the copied reply is linked to it.
    expect(
      c.store.listMessages(forkId, { run: copyRuns[0]?.id ?? "" }),
    ).toHaveLength(1);
  });

  it("names every event field that holds a message or run id", () => {
    // A new event with such a field must be added to the lists in fork.ts.
    const fields = new Set<string>();
    for (const option of EventBody.options) {
      const data = (
        option as unknown as {
          shape: { data: { shape?: Record<string, unknown> } };
        }
      ).shape.data.shape;
      for (const key of Object.keys(data ?? {})) fields.add(key);
    }
    const known = new Set<string>([...MESSAGE_ID_KEYS, ...RUN_ID_KEYS]);
    for (const key of fields) {
      if (/message(s)?id|runid/i.test(key)) {
        expect(known.has(key), `event field ${key}`).toBe(true);
      }
    }
    for (const key of known) expect(fields.has(key)).toBe(true);
  });

  it("copies subagent runs with the message they hang from", async () => {
    const c = await setup();
    const { store } = c;
    const at = (n: number) =>
      new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString();
    store.createSession("s", "Source", at(0));
    store.addMessage("s", "u1", { role: "user", content: "go" }, at(1));
    store.createRun({ id: "r1", sessionId: "s", kind: "loop", now: at(2) });
    store.addMessage(
      "s",
      "a1",
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "call-1",
            name: "start_subagent",
            arguments: {},
          },
        ],
      } as Message,
      at(3),
    );
    store.linkRunMessage("r1", "a1");
    store.createRun({
      id: "r2",
      sessionId: "s",
      kind: "loop",
      now: at(4),
      parent: { runId: "r1", callId: "call-1" },
    });
    store.saveMessage(
      "s",
      "sub1",
      {
        role: "assistant",
        content: [{ type: "text", text: "sub" }],
      } as Message,
      at(5),
      undefined,
      null,
      "a1",
    );
    store.linkRunMessage("r2", "sub1");
    store.insertEvent({
      runId: "r2",
      sessionId: "s",
      time: at(6),
      type: "run.started",
      data: { kind: "loop", parentRunId: "r1", parentCallId: "call-1" },
    } as StoredEvent);
    store.saveMessage(
      "s",
      "t1",
      {
        role: "tool",
        callId: "call-1",
        name: "start_subagent",
        content: "done",
        isError: false,
      } as Message,
      at(7),
    );
    store.linkRunMessage("r1", "t1");
    // t1 follows a1 on the line (saveMessage of a top-level message appends).
    const res = await fork(c, "s", "t1");
    expect(res.status).toBe(201);
    const forkId = res.body.id as string;

    const copied = allMessages(c, forkId);
    const sub = copied.find((m) => text(m) === "sub");
    const holder = copied.find(
      (m) => m.message.role === "assistant" && m.id !== sub?.id,
    );
    expect(sub).toBeTruthy();
    expect(holder).toBeTruthy();
    expect(c.store.getNode(sub?.id ?? "")?.anchorId).toBe(holder?.id);
    expect(c.store.getNode(sub?.id ?? "")?.parentId).toBeNull();

    const runs = c.store.listRuns(forkId);
    expect(runs).toHaveLength(2);
    const child = runs.find((r) => r.parent_call_id === "call-1");
    const parent = runs.find((r) => r.id !== child?.id);
    expect(child?.parent_run_id).toBe(parent?.id);
    expect(child?.id).not.toBe("r2");
    const started = c.store
      .runEvents(child?.id ?? "")
      .find((e) => e.type === "run.started");
    expect((started?.data as { parentRunId?: string }).parentRunId).toBe(
      parent?.id,
    );
  });

  it("copies the session's approvals, media choices and workspaces", async () => {
    const c = await setup([say("a1")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    c.store.allowToolForSession(id, "write_file", "2026-01-01T00:00:00.000Z");
    c.store.setMediaChoice(id, "session://cat.png", true);
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const res = await fork(c, id, reply.id);
    const forkId = res.body.id as string;
    expect(c.store.isToolAllowedForSession(forkId, "write_file")).toBe(true);
    expect(c.store.listMediaChoices(forkId)).toEqual([
      { ref: "session://cat.png", keep: true },
    ]);
  });

  it("forks a fork, remembering only the session it came from", async () => {
    const c = await setup([say("a1")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const one = (await fork(c, id, reply.id, "One")).body.id as string;
    const copy = (await view(c, one)).messages[1] as StoredMessage;
    const two = await fork(c, one, copy.id, "Two");
    expect(two.body).toMatchObject({
      forked_from_id: one,
      forked_from_title: "One",
    });
  });

  it("lets the copy go on without touching the source", async () => {
    const c = await setup([say("a1"), say("a2"), say("b2")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const forkId = (await fork(c, id, reply.id)).body.id as string;
    c.watch(forkId);
    await send(c, forkId, "other");
    expect(await texts(c, forkId)).toEqual(["q1", "a1", "other", "b2"]);
    expect(await texts(c, id)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("reports where a fork came from, and whether that session is still there", async () => {
    const c = await setup([say("a1")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const forkId = (await fork(c, id, reply.id, "Copy")).body.id as string;
    const from = async () =>
      (
        (await api(c.app, "GET", `/api/sessions/${forkId}`)).body as {
          forkedFrom: unknown;
        }
      ).forkedFrom;
    expect(await from()).toEqual({ id, title: "New session", state: "live" });
    await api(c.app, "POST", `/api/sessions/${id}/trash`);
    expect(await from()).toMatchObject({ state: "trashed" });
    await api(c.app, "DELETE", `/api/sessions/${id}`);
    expect(await from()).toMatchObject({
      id,
      title: "New session",
      state: "gone",
    });
    const original = await api(c.app, "GET", `/api/sessions/${id}`);
    expect(original.status).toBe(404);
  });

  it("refuses a missing session or message, a trashed session and an empty title", async () => {
    const c = await setup([say("a1")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    expect((await fork(c, "nope", reply.id)).status).toBe(404);
    expect((await fork(c, id, "nope")).status).toBe(404);
    expect((await fork(c, id, reply.id, "  ")).status).toBe(400);
    await api(c.app, "POST", `/api/sessions/${id}/trash`);
    expect((await fork(c, id, reply.id)).status).toBe(409);
  });

  it("refuses while a run is in progress", async () => {
    const c = await setup([
      [
        { type: "text", text: "slow" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const id = await newSession(c);
    await api(c.app, "POST", `/api/sessions/${id}/messages`, { content: "q1" });
    const first = (await view(c, id)).messages[0] as StoredMessage;
    expect((await fork(c, id, first.id)).status).toBe(409);
  });

  it("only forks at points the line shown allows", async () => {
    const c = await setup([say("a1"), say("a1 again")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    const first = (await view(c, id)).messages[0] as StoredMessage;
    const edit = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "q1 v2" },
    );
    await settle(c, edit.body.runId);
    // The old first message is on another branch.
    expect((await fork(c, id, first.id)).status).toBe(409);
  });
});
