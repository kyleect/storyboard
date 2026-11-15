import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestToolState,
  replaySessionData,
  replaySessionFiles,
  ScriptedModel,
  type ChatRequest,
  type Message,
  type ScriptStep,
  type StoredEvent,
} from "@harness/core";
import { allTools } from "@harness/tools";
import { AppEvents } from "./app-events.js";
import { sessionHistory } from "./history.js";
import {
  buildCarried,
  carriedNotice,
  chooseCarry,
  continuedTitle,
  estimateTokens,
  lastReasoning,
  REASONING_CAP,
} from "./rollover.js";
import { RunManager } from "./runs.js";
import { SearchIndex, transcriptText } from "./search-index.js";
import { sessionSearch } from "./search.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store, type StoredMessage } from "./store.js";
import { clearBuiltinAgents, tempDatabase, tempDir } from "./test-helpers.js";
import { WorkspaceStore } from "./workspaces-store.js";

/* Continuing a session in a new one (session rollover design). */

const TOKEN = "t".repeat(64);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const user = (content: string): Message => ({ role: "user", content });
const text = (content: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
});
const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: ids.map((callId) => ({
    type: "tool_call" as const,
    callId,
    name: "files_list",
    arguments: {},
  })),
});
const result = (callId: string, content = "ok", extra = {}): Message => ({
  role: "tool",
  callId,
  name: "files_list",
  content,
  isError: false,
  ...extra,
});

/** A stored line, for the functions that read one. */
function lineOf(messages: Message[]): StoredMessage[] {
  return messages.map((message, i) => ({
    id: `m${i}`,
    message,
    model: null,
    reasoningEffort: null,
    agent: null,
    usage: null,
    runId: null,
    parentCallId: null,
    parentId: i === 0 ? null : `m${i - 1}`,
    branches: null,
  }));
}

describe("estimateTokens", () => {
  it("counts about four characters to the token, tool calls included", () => {
    expect(estimateTokens(user("x".repeat(400)))).toBe(100);
    expect(estimateTokens(result("1", "x".repeat(40)))).toBe(10);
    expect(estimateTokens(text("abc"))).toBe(1);
    expect(estimateTokens(calls("1"))).toBeGreaterThan(0);
  });
});

describe("chooseCarry", () => {
  it("carries the latest step alone when the context size is not known", () => {
    const line = lineOf([
      user("q1"),
      calls("a"),
      result("a"),
      calls("b"),
      result("b"),
      text("done"),
    ]);
    // The reply after the last tool result is a step of its own.
    expect(chooseCarry(line, undefined)).toEqual({ start: 5, end: 5 });
  });

  it("starts at the user message when the tail is a plain reply to it", () => {
    const line = lineOf([user("q1"), text("a1"), user("q2"), text("a2")]);
    expect(chooseCarry(line, undefined)).toEqual({ start: 2, end: 3 });
  });

  it("keeps earlier steps while they fit the budget, and stops before the one that does not", () => {
    const big = "x".repeat(400); // 100 tokens
    const line = lineOf([
      user(big), // 0
      text(big), // 1
      user(big), // 2
      text(big), // 3
      user(big), // 4
      text(big), // 5
    ]);
    expect(chooseCarry(line, 200)).toEqual({ start: 4, end: 5 });
    expect(chooseCarry(line, 450)).toEqual({ start: 2, end: 5 });
    expect(chooseCarry(line, 10_000)).toEqual({ start: 0, end: 5 });
    // Too small for even the latest step: that step is still carried.
    expect(chooseCarry(line, 1)).toEqual({ start: 4, end: 5 });
  });

  it("never starts at a tool result or between a call and its results", () => {
    const big = "x".repeat(400);
    const line = lineOf([
      user("q"), // 0
      calls("a", "b"), // 1
      result("a", big), // 2
      result("b", big), // 3
      text("done"), // 4
    ]);
    // 100 + 100 tokens of results do not fit; the step holding them is not
    // split, so the copy starts at the final reply.
    expect(chooseCarry(line, 50)).toEqual({ start: 4, end: 4 });
    // Wide enough for the call and both results: it starts at the call.
    expect(chooseCarry(line, 500)).toEqual({ start: 0, end: 4 });
  });

  it("ends at the newest complete point", () => {
    const line = lineOf([user("q"), text("a"), user("q2"), calls("a")]);
    // The last message has a call with no result: the copy ends before it.
    expect(chooseCarry(line, undefined)).toEqual({ start: 2, end: 2 });
  });

  it("has nothing to carry from an empty line or one with no start", () => {
    expect(chooseCarry([], undefined)).toBeNull();
    expect(chooseCarry(lineOf([result("a")]), undefined)).toBeNull();
  });

  it("leaves an earlier carried message out of the choice", () => {
    const line = lineOf([
      { role: "carried", content: "n", files: [] },
      user("q"),
      text("a"),
    ]);
    expect(chooseCarry(line, 10_000)).toEqual({ start: 1, end: 2 });
  });
});

describe("continuedTitle", () => {
  it("numbers the sessions of a chain", () => {
    expect(continuedTitle("Plot")).toBe("Plot (2)");
    expect(continuedTitle("Plot (2)")).toBe("Plot (3)");
    expect(continuedTitle("Plot (a)")).toBe("Plot (a) (2)");
  });
});

describe("buildCarried", () => {
  const blob = { hash: "h".repeat(64), size: 3 };
  const history: Message[] = [
    user("go"),
    result("1", "ok", {
      files: [
        { op: "folder", action: "create", path: "notes" },
        { op: "put", key: "notes/a.md", value: "one" },
        { op: "put", key: "notes/a.md", value: "two" },
        { op: "put", key: "gone.md", value: "x" },
        { op: "delete", key: "gone.md" },
        {
          op: "put",
          key: "cat.png",
          value: "",
          mediaType: "image/png",
          blob,
        },
      ],
      dataOps: [
        {
          op: "schema_put",
          id: "s1",
          name: "Task",
          description: "d",
          version: 1,
          body: { type: "object" },
        },
        {
          op: "schema_put",
          id: "s1",
          name: "Task",
          description: "d",
          version: 2,
          body: { type: "object", title: "v2" },
        },
        {
          op: "schema_put",
          id: "s2",
          name: "Old",
          description: "",
          version: 1,
          body: {},
        },
        { op: "schema_delete", id: "s2" },
        {
          op: "data_put",
          id: "d1",
          schemaId: "s1",
          schemaVersion: 1,
          name: "first",
          description: "",
          value: { a: 1 },
        },
        {
          op: "data_put",
          id: "d2",
          schemaId: "s1",
          schemaVersion: 2,
          name: "second",
          description: "",
          value: { a: 2 },
        },
        { op: "data_delete", id: "d2" },
      ],
      state: { todo: ["a"] },
    }),
  ];

  it("writes the files and folders as they are now, and no deleted ones", () => {
    const carried = buildCarried(history, "Plot");
    const state = replaySessionFiles([carried]);
    expect([...state.files.keys()].sort()).toEqual(["cat.png", "notes/a.md"]);
    expect(state.files.get("notes/a.md")?.value).toBe("two");
    expect(state.files.get("cat.png")?.blob).toEqual(blob);
    expect([...state.folders]).toEqual(["notes"]);
    expect(carried.content).toContain('"Plot"');
  });

  it("keeps every version of a live schema, so data pinned to an older one still has it", () => {
    const state = replaySessionData([buildCarried(history, "Plot")]);
    expect([...state.schemas.keys()]).toEqual(["s1"]);
    const schema = state.schemas.get("s1");
    expect(schema?.version).toBe(2);
    expect([...(schema?.versions.keys() ?? [])]).toEqual([1, 2]);
    expect([...state.data.keys()]).toEqual(["d1"]);
    expect(state.data.get("d1")?.schemaVersion).toBe(1);
  });

  it("carries each tool's latest state where latestToolState finds it", () => {
    const carried = buildCarried(history, "Plot");
    expect(latestToolState([carried], "files_list")).toEqual({ todo: ["a"] });
    expect(latestToolState([carried], "other")).toBeUndefined();
    // Carried again, a later session still has it.
    const again = buildCarried([carried, user("more")], "Plot (2)");
    expect(latestToolState([again], "files_list")).toEqual({ todo: ["a"] });
  });

  it("is a single ordinary message with no empty fields", () => {
    expect(buildCarried([user("hi")], "T")).toEqual({
      role: "carried",
      content: expect.stringContaining("continues"),
      files: [],
    });
  });
});

describe("transcriptText", () => {
  it("takes user text, assistant text and tool results, and nothing else", () => {
    expect(transcriptText(user("hello"))).toBe("hello");
    expect(transcriptText(result("1", "a list"))).toBe("a list");
    expect(
      transcriptText({
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "first" },
          { type: "tool_call", callId: "1", name: "x", arguments: { a: 1 } },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
    expect(transcriptText({ role: "edit", content: "[edit]", files: [] })).toBe(
      "",
    );
    expect(
      transcriptText({ role: "carried", content: "[carried]", files: [] }),
    ).toBe("");
  });
});

// ---- With a database -------------------------------------------------------

const say = (words: string): ScriptStep[] => [{ type: "text", text: words }];
const callStep = (
  callId: string,
  name: string,
  args: object = {},
): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});

async function setup(
  scripts: ScriptStep[][] = [],
  options: {
    settings?: Record<string, unknown>;
    tempRoot?: boolean;
    contextSize?: number | (() => Promise<number | undefined>);
  } = {},
) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...options.settings });
  const store = new Store(t.db);
  const index = new SearchIndex(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  let n = 0;
  const newId = () => `id${++n}`;
  const model = new ScriptedModel(scripts);
  const root = options.tempRoot ? tempDir() : undefined;
  if (root) cleanups.push(root.cleanup);
  const workspaces = new WorkspaceStore(t.db, undefined, undefined, root?.dir);
  const engine = {
    index,
    embeddingModel: () => "",
    embed: () => Promise.resolve([]),
  };
  const runs = new RunManager({
    store,
    workspaces,
    index,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    systemPrompt: () => "BASE",
    ...(options.contextSize
      ? {
          contextSize:
            typeof options.contextSize === "function"
              ? options.contextSize
              : () => Promise.resolve(options.contextSize as number),
        }
      : {}),
    history: (session) =>
      sessionHistory({ ...engine, store, sessionId: session.id }),
    search: (session) =>
      sessionSearch({
        ...engine,
        sessionId: session.id,
        projectId: session.project_id,
      }),
    now,
    newId,
  });
  const app = buildServer({
    store,
    runs,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    now,
    contextSize: () => Promise.resolve({ contextSize: 1000 }),
    keepaliveMs: 60_000,
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  const events: StoredEvent[] = [];
  const watch = (sessionId: string) => {
    cleanups.push(runs.subscribe(sessionId, (e) => events.push(e)));
  };
  return {
    t,
    store,
    index,
    runs,
    app,
    model,
    events,
    watch,
    workspaces,
    engine,
    newId,
    now,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

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
    body: (res.body === "" ? undefined : JSON.parse(res.body)) as Json,
  };
}

/** A session holding these messages, as a run would have left them. */
function seed(c: Ctx, messages: Message[], title = "Plot") {
  const id = c.newId();
  c.store.createSession(id, title, c.now());
  for (const message of messages) {
    c.store.addMessage(id, c.newId(), message, c.now());
  }
  c.watch(id);
  return id;
}

async function send(c: Ctx, sessionId: string, content: string) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content,
  });
  expect(res.status).toBe(202);
  await expect.poll(() => c.runs.isActive(res.body.runId)).toBe(false);
}

const lineText = (c: Ctx, id: string) =>
  c.store.listMessages(id, "top").map((m) => m.message);

/** A long conversation with files, data and tool state. */
const longHistory = (): Message[] => [
  user("first question"),
  calls("a"),
  result("a", "listing", {
    files: [{ op: "put", key: "plan.md", value: "the plan" }],
    state: { step: 1 },
  }),
  text("first answer"),
  user("second question"),
  text("second answer"),
];

describe("rolling a session over", () => {
  it("makes a linked session that holds the carried state and the latest messages", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    expect(res.status).toBe(201);
    const next = res.body;
    expect(next).toMatchObject({
      title: "Plot (2)",
      continued_from_id: id,
      continued_from_title: "Plot",
    });
    const messages = lineText(c, next.id);
    // 1000 tokens x 10% = 100 tokens: everything here is small and fits.
    expect(messages[0]).toMatchObject({ role: "carried" });
    expect(messages.slice(1)).toEqual(longHistory());
    expect(next.continued_carried).toBe(longHistory().length);
    // The files and the tool's state came along, in the first message.
    const files = replaySessionFiles(messages);
    expect(files.files.get("plan.md")?.value).toBe("the plan");
    expect(latestToolState(messages, "files_list")).toEqual({ step: 1 });
  });

  it("carries only what fits the share of the context size, never splitting a step", async () => {
    const c = await setup();
    const big = "x".repeat(400); // 100 tokens
    const id = seed(c, [
      user(big),
      text(big),
      user(big),
      calls("a"),
      result("a", big),
      text(big),
    ]);
    // 10% of 1000 tokens: 100. Only the final reply fits.
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const messages = lineText(c, res.body.id);
    expect(messages.map((m) => m.role)).toEqual(["carried", "assistant"]);
    expect(res.body.continued_carried).toBe(1);
    // Everything, with a larger share.
    writeSettings(c.t.db, { rolloverCarryPercent: 99 });
    const other = seed(c, [user(big), text(big), calls("a"), result("a", big)]);
    const wide = await api(c.app, "POST", `/api/sessions/${other}/rollover`);
    const kept = lineText(c, wide.body.id).map((m) => m.role);
    expect(kept).toEqual(["carried", "user", "assistant", "assistant", "tool"]);
  });

  it("keeps each copy's model and time, and not its usage", async () => {
    const c = await setup();
    const id = c.newId();
    c.store.createSession(id, "Plot", c.now());
    c.store.addMessage(id, "u1", user("q"), "2026-02-01T00:00:00.000Z");
    c.store.addMessage(
      id,
      "a1",
      text("a"),
      "2026-02-01T00:00:01.000Z",
      { model: "m1", reasoningEffort: "low", agent: null },
      { promptTokens: 900, completionTokens: 5 },
    );
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const copies = c.store.listMessages(res.body.id, "top").slice(1);
    expect(copies.map((m) => m.model)).toEqual([null, "m1"]);
    expect(copies.map((m) => m.reasoningEffort)).toEqual([null, "low"]);
    expect(copies.map((m) => m.usage)).toEqual([null, null]);
    const times = c.store.messageTimes(res.body.id);
    expect(times.get(copies[1]?.id ?? "")).toBe("2026-02-01T00:00:01.000Z");
  });

  it("carries the choices of the session: model, agent, approvals and media choices", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    c.store.setSessionChoices(id, { model: "big", reasoningEffort: "high" });
    c.store.allowToolForSession(id, "files_write", c.now());
    c.store.setMediaChoice(id, "session://cat.png", true);
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const next = res.body.id as string;
    expect(res.body).toMatchObject({
      model: "big",
      reasoning_effort: "high",
    });
    expect(c.store.isToolAllowedForSession(next, "files_write")).toBe(true);
    expect(c.store.listMediaChoices(next)).toEqual([
      { ref: "session://cat.png", keep: true },
    ]);
  });

  it("hands the workspaces over: same ids and folders, none left behind", async () => {
    const c = await setup([], { tempRoot: true });
    const id = seed(c, longHistory());
    const real = tempDir();
    cleanups.push(real.cleanup);
    const attached = c.workspaces.create(
      { scope: "session", id },
      { name: "Real", path: real.dir, writable: false },
    );
    const temp = c.workspaces.createTemporary(id, "Scratch");
    writeFileSync(join(temp.path, "n.md"), "N");
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const next = res.body.id as string;
    expect(
      c.workspaces
        .forSession(next, null)
        .map((w) => [w.id, w.path])
        .sort(),
    ).toEqual(
      [
        [attached.id, real.dir],
        [temp.id, temp.path],
      ].sort(),
    );
    expect(c.workspaces.forSession(id, null)).toEqual([]);
    // Purging the old session no longer takes the folder with it.
    c.store.setSessionTrashed(id, c.now());
    c.store.purgeSession(id);
    expect(existsSync(join(temp.path, "n.md"))).toBe(true);
    expect(c.workspaces.forSession(next, null)).toHaveLength(2);
  });

  it("announces itself on the old session's stream", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    expect(c.events.map((e) => [e.type, e.data])).toContainEqual([
      "session.continued",
      { sessionId: res.body.id, title: "Plot (2)" },
    ]);
  });

  it("refuses a session that is running, empty, continued already or not there", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const c = await setup([[{ type: "wait", until: gate }, ...say("a")]]);
    expect(
      (await api(c.app, "POST", "/api/sessions/nope/rollover")).status,
    ).toBe(404);
    const empty = seed(c, []);
    const none = await api(c.app, "POST", `/api/sessions/${empty}/rollover`);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/nothing to carry/);
    const id = seed(c, longHistory());
    const running = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "go",
    });
    const busy = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    expect(busy.status).toBe(409);
    release();
    await expect.poll(() => c.runs.isActive(running.body.runId)).toBe(false);
    expect(
      (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).status,
    ).toBe(201);
    const again = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/continued in another session/);
  });

  it("rolls the new session over in its turn, numbering the titles on", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    const one = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body;
    const two = (
      await api(c.app, "POST", `/api/sessions/${one.id as string}/rollover`)
    ).body;
    expect(two).toMatchObject({
      title: "Plot (3)",
      continued_from_id: one.id,
      continued_from_title: "Plot (2)",
    });
    // The carried state is built afresh from the whole line, not copied.
    const roles = lineText(c, two.id).map((m) => m.role);
    expect(roles.filter((r) => r === "carried")).toHaveLength(1);
    expect(
      replaySessionFiles(lineText(c, two.id)).files.get("plan.md")?.value,
    ).toBe("the plan");
    expect(c.store.chainBefore(two.id)).toEqual([one.id, id]);
  });

  it("works from a session with no known context size", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    const app = buildServer({
      store: c.store,
      runs: c.runs,
      events: new AppEvents(),
      token: TOKEN,
      env: {},
      contextSize: () => Promise.reject(new Error("down")),
      keepaliveMs: 60_000,
    });
    cleanups.push(() => app.close());
    const res = await api(app, "POST", `/api/sessions/${id}/rollover`);
    expect(res.status).toBe(201);
    // Only the latest step: the reply to the second question.
    expect(lineText(c, res.body.id).map((m) => m.role)).toEqual([
      "carried",
      "user",
      "assistant",
    ]);
  });
});

describe("a session that was continued", () => {
  async function continued(c: Ctx) {
    const id = seed(c, longHistory());
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    return { id, next };
  }

  it("is read only: sending, continuing, editing, branching and file edits are refused", async () => {
    const c = await setup([say("never")]);
    const { id } = await continued(c);
    const first = c.store.listMessages(id, "top")[0] as StoredMessage;
    const refused: [string, string, unknown?][] = [
      ["POST", `/api/sessions/${id}/messages`, { content: "hi" }],
      ["POST", `/api/sessions/${id}/continue`, {}],
      ["POST", `/api/sessions/${id}/regenerate`, {}],
      [
        "PATCH",
        `/api/sessions/${id}/messages/${first.id}`,
        { content: "edited" },
      ],
      ["POST", `/api/sessions/${id}/branch`, { messageId: first.id }],
      ["POST", `/api/sessions/${id}/switch`, { messageId: first.id }],
      ["DELETE", `/api/sessions/${id}/branches/${first.id}`],
    ];
    for (const [method, url, body] of refused) {
      const res = await api(
        c.app,
        method as "POST",
        url,
        body ?? (method === "POST" ? {} : undefined),
      );
      expect(res.status, `${method} ${url}`).toBe(409);
      expect(res.body.error).toMatch(/continued in another session/);
      expect(res.body.continuedTo).toMatchObject({ title: "Plot (2)" });
    }
    expect(() => c.runs.editSessionFiles(id, [])).toThrow(/continued/);
    expect(() => c.runs.editSessionData(id, [])).toThrow(/continued/);
    expect(c.model.requests).toHaveLength(0);
    // Nothing was added to it.
    expect(lineText(c, id)).toEqual(longHistory());
  });

  it("can still be renamed, forked and moved to the trash", async () => {
    const c = await setup();
    const { id } = await continued(c);
    const renamed = await api(c.app, "PATCH", `/api/sessions/${id}`, {
      title: "Renamed",
    });
    expect(renamed.status).toBe(200);
    const line = c.store.listMessages(id, "top");
    const fork = await api(c.app, "POST", `/api/sessions/${id}/fork`, {
      messageId: line[0]?.id,
      title: "Fork",
    });
    expect(fork.status).toBe(201);
    // Moving it to the trash needs the user to confirm (see below).
    const trash = await api(c.app, "POST", `/api/sessions/${id}/trash`, {
      force: true,
    });
    expect(trash.status).toBe(200);
  });

  it("shows its place in the chain in the session and in the lists", async () => {
    const c = await setup();
    const { id, next } = await continued(c);
    const old = (await api(c.app, "GET", `/api/sessions/${id}`)).body;
    expect(old.continuedTo).toEqual({
      id: next,
      title: "Plot (2)",
      trashed: false,
    });
    expect(old.continuedFrom).toBeNull();
    const fresh = (await api(c.app, "GET", `/api/sessions/${next}`)).body;
    expect(fresh.continuedFrom).toEqual({
      id,
      title: "Plot",
      state: "live",
      carried: longHistory().length,
    });
    expect(fresh.continuedTo).toBeNull();
    const list = (await api(c.app, "GET", "/api/sessions")).body as Json[];
    expect(list.find((s) => s.id === id)?.continuedTo).toMatchObject({
      id: next,
    });
    expect(list.find((s) => s.id === next)?.continuedTo).toBeNull();
    const page = (await api(c.app, "GET", "/api/sessions-page")).body;
    expect(
      page.items.find((s: Json) => s.id === id)?.continuedTo,
    ).toMatchObject({ id: next });
  });

  it("stays read only while the new session is in the trash, and not once it is purged", async () => {
    const c = await setup();
    const { id, next } = await continued(c);
    await api(c.app, "POST", `/api/sessions/${next}/trash`);
    expect(
      (
        await api(c.app, "POST", `/api/sessions/${id}/messages`, {
          content: "x",
        })
      ).status,
    ).toBe(409);
    c.store.purgeSession(next);
    const after = await api(c.app, "GET", `/api/sessions/${id}`);
    expect(after.body.continuedTo).toBeNull();
    expect(c.store.chainBefore(next)).toEqual([]);
  });

  it("names the predecessor after it is purged", async () => {
    const c = await setup();
    const { id, next } = await continued(c);
    c.store.setSessionTrashed(id, c.now());
    c.store.purgeSession(id);
    const fresh = (await api(c.app, "GET", `/api/sessions/${next}`)).body;
    expect(fresh.continuedFrom).toMatchObject({
      id,
      title: "Plot",
      state: "gone",
    });
    expect(c.store.chainBefore(next)).toEqual([]);
  });
});

describe("the trash and the chain", () => {
  async function chain(c: Ctx) {
    const id = seed(c, longHistory());
    const one = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    const two = (await api(c.app, "POST", `/api/sessions/${one}/rollover`)).body
      .id as string;
    return { id, one, two };
  }

  it("asks before moving a session to the trash that later ones continue, and names them", async () => {
    const c = await setup();
    const { id, one, two } = await chain(c);
    const res = await api(c.app, "POST", `/api/sessions/${id}/trash`);
    expect(res.status).toBe(409);
    expect(res.body.needsForce).toBe(true);
    expect(res.body.continuedBy).toEqual([
      { id: one, title: "Plot (2)" },
      { id: two, title: "Plot (3)" },
    ]);
    expect(c.store.getSession(id)?.trashed_at).toBeNull();
    // The newest session has no one after it.
    const last = await api(c.app, "POST", `/api/sessions/${two}/trash`);
    expect(last.status).toBe(200);
    // And the user may go ahead.
    const forced = await api(c.app, "POST", `/api/sessions/${id}/trash`, {
      force: true,
    });
    expect(forced.status).toBe(200);
  });

  it("says why in the bulk move, and moves it when forced", async () => {
    const c = await setup();
    const { id } = await chain(c);
    const refused = await api(c.app, "POST", "/api/sessions/trash", {
      ids: [id],
    });
    expect(refused.body.trashed).toEqual([]);
    expect(refused.body.refused[0].error).toMatch(/Plot \(2\)/);
    const forced = await api(c.app, "POST", "/api/sessions/trash", {
      ids: [id],
      force: true,
    });
    expect(forced.body.trashed).toEqual([id]);
  });

  it("does not purge a session that a kept session continues, unless the trash is emptied", async () => {
    const c = await setup();
    const { id, one } = await chain(c);
    await api(c.app, "POST", `/api/sessions/${id}/trash`, { force: true });
    const later = "2999-01-01T00:00:00.000Z";
    expect(
      c.store.purgeTrashedSessions(later, { keepContinued: true }),
    ).toEqual([]);
    expect(c.store.getSession(id)).toBeDefined();
    // Once nothing continues it any more, it goes.
    await api(c.app, "POST", `/api/sessions/${one}/trash`, { force: true });
    c.store.purgeSession(one);
    const two = c.store.listSessions().map((s) => s.id);
    expect(two).toHaveLength(1);
    expect(
      c.store.purgeTrashedSessions(later, { keepContinued: true }),
    ).toEqual([id]);
  });

  it("empties the trash whatever continues what", async () => {
    const c = await setup();
    const { id } = await chain(c);
    await api(c.app, "POST", `/api/sessions/${id}/trash`, { force: true });
    const res = await api(c.app, "DELETE", "/api/trash");
    expect(res.body.purged.sessions).toBe(1);
    expect(c.store.getSession(id)).toBeUndefined();
  });

  it("does not count a session trashed with its project as keeping one", async () => {
    const c = await setup();
    const project = c.store.createProject({
      id: "p1",
      name: "P",
      description: "",
      now: c.now(),
    } as never);
    const id = c.newId();
    c.store.createSession(id, "Plot", c.now(), project.id);
    for (const m of longHistory())
      c.store.addMessage(id, c.newId(), m, c.now());
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    expect(c.store.getSession(next)?.project_id).toBe(project.id);
    // Trashing the project trashes both; the predecessor purges with it.
    await api(c.app, "POST", `/api/projects/${project.id}/trash`);
    expect(c.store.chainAfter(id)).toEqual([]);
    expect(
      c.store.purgeTrashedSessions("2999-01-01", { keepContinued: true }),
    ).toEqual([]);
    c.store.purgeProject(project.id);
    expect(c.store.getSession(id)).toBeUndefined();
    expect(c.store.getSession(next)).toBeUndefined();
  });
});

describe("indexing the transcript", () => {
  const chunks = (c: Ctx, id: string) =>
    (
      c.t.db
        .prepare(
          "SELECT key, seq, text FROM chunks WHERE scope = 'transcript' AND owner_id = ? ORDER BY key, seq",
        )
        .all(id) as { key: string; seq: number; text: string }[]
    ).map((r) => ({ ...r }));

  it("indexes each message as it is saved: the user's, the assistant's and tool results", async () => {
    const c = await setup([
      [callStep("1", "current_date"), { type: "text", text: "Checking." }],
      say("It is a lighthouse day."),
    ]);
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await send(c, id, "Tell me about harbours");
    const keys = c.store
      .listMessages(id, "top")
      .map((m) => [m.message.role, m.id] as const);
    const indexed = chunks(c, id);
    // user, assistant (with a call), tool result, assistant: each has chunks
    // unless its text is empty.
    expect(indexed.map((x) => x.key)).toEqual(
      expect.arrayContaining(keys.map(([, k]) => k).slice(0, 1)),
    );
    expect(indexed.map((x) => x.text)).toEqual(
      expect.arrayContaining([
        "Tell me about harbours",
        "It is a lighthouse day.",
      ]),
    );
  });

  it("indexes the text of an edit, in place and as a branch", async () => {
    const c = await setup([say("a")], {
      settings: { answerAfterEdit: false },
    });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await send(c, id, "original words");
    const first = c.store.listMessages(id, "top")[0] as StoredMessage;
    await api(c.app, "PATCH", `/api/sessions/${id}/messages/${first.id}`, {
      content: "rewritten words",
      mode: "in_place",
    });
    expect(chunks(c, id).find((x) => x.key === first.id)?.text).toBe(
      "rewritten words",
    );
    const branch = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "branched words", mode: "branch" },
    );
    expect(
      chunks(c, id).find((x) => x.key === branch.body.messageId)?.text,
    ).toBe("branched words");
  });

  it("splits a large message into chunks that share its key", () => {
    const c = { t: tempDatabase() };
    cleanups.push(c.t.cleanup);
    const index = new SearchIndex(c.t.db);
    const long = Array.from({ length: 200 }, (_, i) => `Sentence ${i}.`).join(
      " ",
    );
    index.indexMessage("s1", "m1", result("1", long));
    const rows = c.t.db
      .prepare(
        "SELECT key, seq FROM chunks WHERE scope = 'transcript' AND owner_id = 's1' ORDER BY seq",
      )
      .all() as { key: string; seq: number }[];
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(["m1"]));
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
    // Saved again with no text, nothing is left.
    index.indexMessage("s1", "m1", calls("1"));
    expect(
      c.t.db
        .prepare("SELECT count(*) AS n FROM chunks WHERE scope = 'transcript'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("leaves the messages of another branch and of subagents out when the session rolls over", async () => {
    const c = await setup([say("a")], { settings: { answerAfterEdit: false } });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await send(c, id, "original words");
    const first = c.store.listMessages(id, "top")[0] as StoredMessage;
    await api(c.app, "PATCH", `/api/sessions/${id}/messages/${first.id}`, {
      content: "branched words",
      mode: "branch",
    });
    expect(chunks(c, id).map((x) => x.text)).toContain("original words");
    await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const left = chunks(c, id).map((x) => x.text);
    expect(left).toContain("branched words");
    expect(left).not.toContain("original words");
  });

  it("indexes, at the rollover, a session that was never indexed, and keeps vectors of what stays", async () => {
    const c = await setup();
    // Messages that were written before there was an index.
    const id = seed(c, longHistory());
    c.t.db.prepare("DELETE FROM chunks").run();
    expect(chunks(c, id)).toEqual([]);
    const kept = c.store.listMessages(id, "top")[0] as StoredMessage;
    c.index.indexMessage(id, kept.id, kept.message);
    const chunkId = (
      c.t.db.prepare("SELECT id FROM chunks WHERE owner_id = ?").get(id) as {
        id: number;
      }
    ).id;
    c.index.saveVectors("m", [{ id: chunkId, vector: [1, 0] }]);
    const result = c.index.reconcileTranscript(id);
    expect(result).toEqual({ removed: 0, added: 4 });
    expect(chunks(c, id).map((x) => x.text)).toEqual(
      expect.arrayContaining(["first question", "second answer"]),
    );
    expect(
      c.t.db
        .prepare("SELECT count(*) AS n FROM chunk_vectors WHERE chunk_id = ?")
        .get(chunkId),
    ).toEqual({ n: 1 });
    // Nothing changes the second time.
    expect(c.index.reconcileTranscript(id)).toEqual({ removed: 0, added: 0 });
  });

  it("is removed when the session is purged, and is not found by files_search", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    c.index.reconcileTranscript(id);
    expect(chunks(c, id).length).toBeGreaterThan(0);
    const files = await sessionSearch({
      ...c.engine,
      sessionId: id,
      projectId: null,
    })({
      query: "question",
      scopes: ["session", "project", "global"],
      limit: 10,
    });
    expect(files.hits).toEqual([]);
    c.store.setSessionTrashed(id, c.now());
    c.store.purgeSession(id);
    expect(chunks(c, id)).toEqual([]);
  });
});

describe("the history of a chain", () => {
  async function twoSessions(c: Ctx, earlier: Message[]) {
    const id = seed(c, earlier);
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    return { id, next };
  }
  const history = (c: Ctx, sessionId: string) =>
    sessionHistory({ ...c.engine, store: c.store, sessionId });

  it("searches the earlier sessions of the chain by keyword, with titles and message ids", async () => {
    const c = await setup();
    const { id, next } = await twoSessions(c, [
      user("We chose the lighthouse design"),
      text("Noted: lighthouse it is."),
      user("Now something else entirely"),
      text("ok"),
    ]);
    const found = await history(c, next).search({
      query: "lighthouse",
      limit: 10,
      offset: 0,
    });
    expect(found.mode).toBe("keyword");
    expect(found.notice).toMatch(/No embedding model/);
    expect(found.hasMore).toBe(false);
    const first = c.store.listMessages(id, "top")[0] as StoredMessage;
    expect(found.hits.map((h) => h.excerpt)).toEqual(
      expect.arrayContaining(["We chose the lighthouse design"]),
    );
    expect(found.hits.find((h) => h.messageId === first.id)).toMatchObject({
      sessionId: id,
      sessionTitle: "Plot",
      matched: "keyword",
    });
    // The new session's own messages are not in what it searches.
    c.index.indexMessage(next, "own", user("lighthouse in the new session"));
    const again = await history(c, next).search({
      query: "lighthouse",
      limit: 10,
      offset: 0,
    });
    expect(again.hits.every((h) => h.sessionId === id)).toBe(true);
  });

  it("pages the hits and says when more follow", async () => {
    const c = await setup();
    const messages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(user(`harbour note ${i}`), text(`reply ${i}`));
    }
    const { next } = await twoSessions(c, messages);
    const h = history(c, next);
    const page1 = await h.search({ query: "harbour", limit: 2, offset: 0 });
    const page2 = await h.search({ query: "harbour", limit: 2, offset: 2 });
    const page3 = await h.search({ query: "harbour", limit: 2, offset: 4 });
    expect(page1.hits).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(true);
    expect(page3.hits).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    const ids = [...page1.hits, ...page2.hits, ...page3.hits].map(
      (x) => x.messageId,
    );
    expect(new Set(ids).size).toBe(5);
  });

  it("has nothing to search in a session that continues none", async () => {
    const c = await setup();
    const id = seed(c, longHistory());
    c.index.reconcileTranscript(id);
    const found = await history(c, id).search({
      query: "question",
      limit: 10,
      offset: 0,
    });
    expect(found.hits).toEqual([]);
  });

  it("reads a window of messages around one, with the tools called, cut when long", async () => {
    const c = await setup();
    const long = "word ".repeat(2000);
    const { id, next } = await twoSessions(c, [
      user("one"),
      calls("a"),
      result("a", long),
      text("two"),
      user("three"),
      text("four"),
    ]);
    const line = c.store.listMessages(id, "top");
    const read = history(c, next).read({
      sessionId: id,
      messageId: line[3]?.id ?? "",
      before: 2,
      after: 1,
    });
    if ("error" in read) throw new Error(read.error);
    expect(read.sessionTitle).toBe("Plot");
    expect(read.messages.map((m) => [m.role, m.id])).toEqual([
      ["assistant", line[1]?.id],
      ["tool", line[2]?.id],
      ["assistant", line[3]?.id],
      ["user", line[4]?.id],
    ]);
    expect(read.messages[0]).toMatchObject({ calls: ["files_list"], text: "" });
    expect(read.messages[1]?.truncated).toBe(true);
    expect(read.messages[1]?.tool).toBe("files_list");
    expect(read.messages[1]?.text.length).toBeLessThan(long.length);
    expect(read.hasBefore).toBe(true);
    expect(read.hasAfter).toBe(true);
    const all = history(c, next).read({
      sessionId: id,
      messageId: line[0]?.id ?? "",
      before: 50,
      after: 50,
    });
    if ("error" in all) throw new Error(all.error);
    expect(all.messages).toHaveLength(6);
    expect([all.hasBefore, all.hasAfter]).toEqual([false, false]);
  });

  it("refuses a session outside the chain, and a message that is not in the session", async () => {
    const c = await setup();
    const { id, next } = await twoSessions(c, longHistory());
    const stranger = seed(c, [user("secret"), text("hidden")], "Other");
    const other = c.store.listMessages(stranger, "top")[0] as StoredMessage;
    const h = history(c, next);
    expect(
      h.read({ sessionId: stranger, messageId: other.id, before: 1, after: 1 }),
    ).toEqual({ error: expect.stringMatching(/not one this session was/) });
    expect(
      h.read({ sessionId: id, messageId: other.id, before: 1, after: 1 }),
    ).toEqual({ error: expect.stringMatching(/not in the session/) });
    // The new session itself is not in its own chain.
    expect(
      h.read({ sessionId: next, messageId: other.id, before: 1, after: 1 }),
    ).toEqual({ error: expect.stringMatching(/not one this session was/) });
  });
});

describe("a session that continues another, in a run", () => {
  const names = (c: Ctx, at = 0) =>
    ((c.model.requests[at] as ChatRequest).tools ?? []).map((t) => t.name);
  const results = (c: Ctx, id: string) =>
    c.store.listMessages(id, "top").flatMap((m) =>
      m.message.role === "tool"
        ? [
            {
              name: m.message.name,
              isError: m.message.isError,
              data: m.message.data as Json,
            },
          ]
        : [],
    );

  it("gets the search tools and a note in its system message; others do not", async () => {
    const c = await setup([say("a"), say("b")]);
    const plain = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(plain);
    await send(c, plain, "hello");
    expect(names(c, 0)).not.toContain("sessions_search");
    expect(names(c, 0)).not.toContain("sessions_read");
    expect((c.model.requests[0] as ChatRequest).messages[0]).toMatchObject({
      role: "system",
      content: "BASE",
    });

    const id = seed(c, longHistory());
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    c.watch(next);
    await send(c, next, "carry on");
    expect(names(c, 1)).toEqual(
      expect.arrayContaining(["sessions_search", "sessions_read"]),
    );
    const system = (c.model.requests[1] as ChatRequest).messages[0];
    expect(system).toMatchObject({ role: "system" });
    const content = (system as { content: string }).content;
    expect(content).toMatch(/^BASE\n\nThis session continues "Plot"/);
    expect(content).toMatch(/sessions_search/);
    // The carried message comes first; the adapter folds it into a user message.
    const sent = (c.model.requests[1] as ChatRequest).messages;
    expect(sent[1]).toMatchObject({ role: "carried" });
    expect((sent[1] as { content: string }).content).toMatch(
      /continues "Plot"/,
    );
  });

  it("leaves the note out when the agent has the tools turned off, and when there is no history", async () => {
    const c = await setup([say("a")]);
    const id = seed(c, longHistory());
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    c.store.purgeSession(id);
    c.watch(next);
    await send(c, next, "carry on");
    // The predecessor is gone: nothing to search, so no tools and no note.
    expect(names(c)).not.toContain("sessions_search");
    const system = (c.model.requests[0] as ChatRequest).messages[0] as {
      content: string;
    };
    expect(system.content).toBe("BASE");
  });

  it("finds an earlier message with sessions_search and reads around it with sessions_read", async () => {
    const c = await setup([
      [callStep("1", "sessions_search", { query: "zeppelin" })],
      say("found it"),
    ]);
    const id = seed(c, [
      user("Remember the zeppelin hangar"),
      text("Yes, noted."),
      user("something else"),
      text("sure"),
    ]);
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    c.watch(next);
    await send(c, next, "what did we say about the zeppelin?");
    const [r] = results(c, next);
    expect(r?.isError).toBe(false);
    expect(r?.data.hits).toHaveLength(1);
    expect(r?.data.hits[0]).toMatchObject({
      session: "Plot",
      sessionId: id,
      excerpt: "Remember the zeppelin hangar",
      matched: "keyword",
    });
    expect(r?.data.hasMore).toBe(false);
  });

  it("answers sessions_read through a run, and an error for a session outside the chain", async () => {
    const scripts: ScriptStep[][] = [];
    const c = await setup(scripts);
    const id = seed(c, [user("alpha"), text("beta"), user("gamma")]);
    const first = c.store.listMessages(id, "top")[0] as StoredMessage;
    scripts.push(
      [
        callStep("1", "sessions_read", {
          sessionId: id,
          messageId: first.id,
          before: 0,
          after: 1,
        }),
      ],
      [callStep("2", "sessions_read", { sessionId: "nope", messageId: "x" })],
      say("done"),
    );
    const next = (await api(c.app, "POST", `/api/sessions/${id}/rollover`)).body
      .id as string;
    c.watch(next);
    await send(c, next, "read it");
    const [ok, bad] = results(c, next);
    expect(ok?.isError).toBe(false);
    expect(ok?.data.messages.map((m: Json) => [m.role, m.text])).toEqual([
      ["user", "alpha"],
      ["assistant", "beta"],
    ]);
    expect(bad?.isError).toBe(true);
    expect(bad?.data.error).toMatch(/not one this session was continued from/);
  });
});

/* Continuing by itself when the context is full (patch 2). */

const used = (promptTokens: number): ScriptStep => ({
  type: "usage",
  usage: { promptTokens, completionTokens: 0 },
});

describe("rolling over by itself", () => {
  /** Waits until no run is going, in any session. */
  const settled = async (c: Ctx) => {
    await expect
      .poll(
        () =>
          (
            c.t.db
              .prepare(
                "SELECT count(*) AS n FROM runs WHERE status = 'running'",
              )
              .get() as { n: number }
          ).n,
      )
      .toBe(0);
    // The run in the new session starts a moment after the old one ends.
    await new Promise((r) => setTimeout(r, 50));
    await expect
      .poll(
        () =>
          (
            c.t.db
              .prepare(
                "SELECT count(*) AS n FROM runs WHERE status = 'running'",
              )
              .get() as { n: number }
          ).n,
      )
      .toBe(0);
  };
  const post = async (c: Ctx, id: string, content: string) => {
    const res = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content,
    });
    expect(res.status).toBe(202);
    await settled(c);
    return res.body as { runId: string; sessionId: string };
  };
  const chain = (c: Ctx, id: string) => {
    const ids = [id];
    for (;;) {
      const next = c.store.continuedTo(ids[ids.length - 1] as string);
      if (!next) return ids;
      ids.push(next.id);
    }
  };
  const finishes = (c: Ctx) =>
    c.events.flatMap((e) =>
      e.type === "run.finished" ? [(e.data as { reason: string }).reason] : [],
    );

  it("ends the run after the step that filled the context, and goes on in a new session", async () => {
    const c = await setup(
      [
        [callStep("1", "current_date"), used(900)],
        [...say("All done."), used(100)],
      ],
      { contextSize: 1000 },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    const sent = await post(c, id, "What day is it?");
    expect(sent.sessionId).toBe(id);
    const [, next] = chain(c, id);
    expect(next).toBeDefined();
    expect(finishes(c)).toEqual(["rolled_over"]);
    // The old session ends at the tool result, a whole step.
    expect(lineText(c, id).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    // The new one has it carried, and the next step's reply.
    const roles = lineText(c, next as string).map((m) => m.role);
    expect(roles).toEqual([
      "carried",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    // The second request is the next step: it ends with the tool result.
    expect(c.model.requests).toHaveLength(2);
    const second = (c.model.requests[1] as ChatRequest).messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", name: "current_date" });
  });

  it("goes by the last call's tokens, not the sum of the run", async () => {
    const c = await setup(
      [
        [callStep("1", "current_date"), used(700)],
        [callStep("2", "current_date"), used(790)],
        [...say("Done."), used(799)],
      ],
      { contextSize: 1000 },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "go");
    expect(chain(c, id)).toEqual([id]);
    expect(finishes(c)).toEqual(["stop"]);
  });

  it("does nothing when the context size is not known, or the action is off", async () => {
    const scripts = (): ScriptStep[][] => [
      [callStep("1", "current_date"), used(990)],
      [...say("Done."), used(999)],
    ];
    const unknown = await setup(scripts());
    const a = (await api(unknown.app, "POST", "/api/sessions", {})).body.id;
    unknown.watch(a);
    await post(unknown, a, "go");
    expect(chain(unknown, a)).toEqual([a]);

    const off = await setup(scripts(), {
      contextSize: 1000,
      settings: { contextFullAction: "off" },
    });
    const b = (await api(off.app, "POST", "/api/sessions", {})).body.id;
    off.watch(b);
    await post(off, b, "go");
    expect(chain(off, b)).toEqual([b]);
  });

  it("does not end the run on the last step the loop limit allows", async () => {
    const c = await setup([[callStep("1", "current_date"), used(900)]], {
      contextSize: 1000,
      settings: { loopLimit: 1 },
    });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "go");
    expect(chain(c, id)).toEqual([id]);
    expect(finishes(c)).toEqual(["iteration_limit"]);
  });

  it("counts the steps taken against the loop limit of the next session", async () => {
    const c = await setup(
      [
        [callStep("1", "current_date"), used(900)],
        [callStep("2", "current_date"), used(900)],
        [callStep("3", "current_date"), used(900)],
      ],
      { contextSize: 1000, settings: { loopLimit: 3 } },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "go");
    // Two steps ran in two sessions that rolled over; the third session had
    // one call left, made it, and then hit the limit.
    const ids = chain(c, id);
    expect(ids).toHaveLength(3);
    expect(c.model.requests).toHaveLength(3);
    expect(c.store.continuedTo(ids[2] as string)).toBeUndefined();
  });

  it("does not roll over after a reply with no tool calls", async () => {
    const c = await setup([[...say("A long answer."), used(950)]], {
      contextSize: 1000,
    });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "tell me");
    expect(chain(c, id)).toEqual([id]);
    expect(finishes(c)).toEqual(["stop"]);
  });

  it("rolls over before the next run when the last reply filled the context, and takes the message", async () => {
    const c = await setup(
      [
        [...say("A long answer."), used(950)],
        [...say("Carrying on."), used(100)],
      ],
      { contextSize: 1000 },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "first");
    const sent = await post(c, id, "second");
    expect(sent.sessionId).not.toBe(id);
    expect(chain(c, id)).toEqual([id, sent.sessionId]);
    // The old session did not get the message.
    expect(lineText(c, id).map((m) => m.role)).toEqual(["user", "assistant"]);
    const roles = lineText(c, sent.sessionId).map((m) => m.role);
    expect(roles).toEqual([
      "carried",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const messages = lineText(c, sent.sessionId);
    expect(messages[3]).toMatchObject({ role: "user", content: "second" });
    // And the answer came from the new session's run.
    expect(c.model.requests).toHaveLength(2);
  });

  it("keeps the choices of the message on the new session", async () => {
    const c = await setup([[...say("A.")].concat([used(950)]), say("B.")], {
      contextSize: 1000,
    });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "first");
    const res = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "second",
      model: "other",
    });
    await settled(c);
    expect(c.store.getSession(res.body.sessionId)?.model).toBe("other");
    expect(c.store.getSession(id)?.model ?? "").not.toBe("other");
  });

  it("does not roll over when the usage is not reported or is below the threshold", async () => {
    const c = await setup([say("a"), say("b")], { contextSize: 1000 });
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await post(c, id, "one");
    const second = await post(c, id, "two");
    expect(second.sessionId).toBe(id);
  });
});

describe("when the context size cannot be read", () => {
  const settledRuns = async (c: Ctx) => {
    await expect
      .poll(
        () =>
          (
            c.t.db
              .prepare(
                "SELECT count(*) AS n FROM runs WHERE status = 'running'",
              )
              .get() as { n: number }
          ).n,
      )
      .toBe(0);
    await new Promise((r) => setTimeout(r, 50));
  };

  it.each([
    ["is not reported", () => Promise.resolve(undefined)],
    ["fails", () => Promise.reject(new Error("down"))],
  ])("uses the size found before when a lookup %s", async (_name, fail) => {
    let calls = 0;
    const c = await setup(
      [
        [...say("First."), used(100)],
        [callStep("1", "current_date"), used(900)],
        [...say("Carried on."), used(100)],
      ],
      {
        contextSize: () => (calls++ === 0 ? Promise.resolve(1000) : fail()),
      },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "one",
    });
    await settledRuns(c);
    expect(calls).toBe(1);
    await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "two",
    });
    await settledRuns(c);
    // The second run could not read the size and used the first one: its
    // step at 900 of 1000 ended the run and went on in a new session.
    expect(calls).toBeGreaterThan(1);
    const next = c.store.continuedTo(id);
    expect(next).toBeDefined();
    expect(c.model.requests).toHaveLength(3);
  });

  it("has no size to use when it was never read", async () => {
    const c = await setup(
      [[callStep("1", "current_date"), used(900)], say("Done.")],
      { contextSize: () => Promise.resolve(undefined) },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "go",
    });
    await settledRuns(c);
    expect(c.store.continuedTo(id)).toBeUndefined();
  });

  it("rolls over before the next message with the size found before", async () => {
    let calls = 0;
    const c = await setup(
      [
        [...say("A long answer."), used(950)],
        [...say("Carrying on."), used(100)],
      ],
      {
        contextSize: () =>
          calls++ === 0 ? Promise.resolve(1000) : Promise.resolve(undefined),
      },
    );
    const id = (await api(c.app, "POST", "/api/sessions", {})).body.id;
    c.watch(id);
    await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "first",
    });
    await settledRuns(c);
    const sent = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "second",
    });
    await settledRuns(c);
    expect(sent.body.sessionId).not.toBe(id);
  });
});

describe("carrying the last reasoning", () => {
  const thinking = (reasoning: string): Message => ({
    role: "assistant",
    content: [
      { type: "reasoning", text: reasoning },
      { type: "tool_call", callId: "a", name: "files_list", arguments: {} },
    ],
  });

  it("takes the reasoning of the newest assistant message, and nothing from older ones", () => {
    expect(
      lastReasoning([
        thinking("old plan"),
        result("a"),
        thinking("the plan: read the files, then write the summary"),
        result("a"),
      ]),
    ).toBe("the plan: read the files, then write the summary");
    // The newest assistant message has none: nothing is dug up from before.
    expect(
      lastReasoning([thinking("old plan"), result("a"), text("done")]),
    ).toBe("");
    expect(lastReasoning([user("hi")])).toBe("");
    expect(lastReasoning([])).toBe("");
  });

  it("joins several reasoning blocks, and keeps the end of a long one", () => {
    expect(
      lastReasoning([
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "first" },
            { type: "text", text: "said" },
            { type: "reasoning", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
    const long = `${"a".repeat(REASONING_CAP)}THE END`;
    const cut = lastReasoning([thinking(long)]);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("THE END")).toBe(true);
    expect(cut.length).toBe(REASONING_CAP + 1);
  });

  it("puts it in the notice after the usual text, and leaves the notice as it was without it", () => {
    expect(carriedNotice("Plot")).toBe(carriedNotice("Plot", ""));
    expect(carriedNotice("Plot")).not.toContain("reasoning");
    const notice = carriedNotice("Plot", "Next I read plan.md.");
    expect(notice.startsWith(carriedNotice("Plot"))).toBe(true);
    expect(notice).toMatch(/Carry on from the last message below/);
    expect(notice.endsWith("Next I read plan.md.")).toBe(true);
  });

  it("is in the carried message of the new session, from the step that was copied", async () => {
    const c = await setup();
    const id = seed(c, [
      user("Summarise the plan"),
      thinking("I will list the files, then read plan.md."),
      result("a", "plan.md"),
    ]);
    const res = await api(c.app, "POST", `/api/sessions/${id}/rollover`);
    const [carried, ...copies] = lineText(c, res.body.id);
    expect(carried).toMatchObject({ role: "carried" });
    expect((carried as { content: string }).content).toMatch(
      /I will list the files, then read plan\.md\.$/,
    );
    // The messages themselves are copied as they were, reasoning and all.
    expect(copies[1]).toEqual(
      thinking("I will list the files, then read plan.md."),
    );
  });

  it("is left out when the last step had no reasoning, and when it is not in the copied messages", async () => {
    const c = await setup();
    const plain = seed(c, [user("hi"), text("hello")]);
    const one = await api(c.app, "POST", `/api/sessions/${plain}/rollover`);
    expect((lineText(c, one.body.id)[0] as { content: string }).content).toBe(
      carriedNotice("Plot"),
    );
    // A step that was started and not finished is not copied, and neither
    // is its reasoning.
    const open = seed(c, [
      user("one"),
      text("a"),
      user("two"),
      thinking("an unfinished plan"),
    ]);
    const two = await api(c.app, "POST", `/api/sessions/${open}/rollover`);
    expect(
      (lineText(c, two.body.id)[0] as { content: string }).content,
    ).not.toContain("an unfinished plan");
  });
});
