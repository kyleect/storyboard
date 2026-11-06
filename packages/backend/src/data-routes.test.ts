import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel } from "@harness/core";
import { AgentStore } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { DataStore } from "./data-store.js";
import { schemaChecker } from "./json-schema.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS } from "./settings.js";
import { Store } from "./store.js";
import { grant, tempDatabase } from "./test-helpers.js";

/* Data routes (schemas and data design, decisions 19 to 25, 44), patch 3. */

const TOKEN = "t".repeat(64);
const TASK = {
  type: "object",
  properties: { task: { type: "string" }, isDone: { type: "boolean" } },
  required: ["task"],
};

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const t = tempDatabase();
  const store = new Store(t.db);
  const events = new AppEvents();
  const seen: AppEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const data = new DataStore(t.db, schemaChecker);
  const agents = new AgentStore(t.db);
  const runs = new RunManager({
    store,
    settings: () => ({ ...DEFAULTS, autoRename: false }),
    model: () => new ScriptedModel([]),
    events,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    data,
    events,
    token: TOKEN,
    env: {},
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  data
    .shared({ projectId: null, agentId: null })
    .createSchema(
      "global",
      { id: "task", name: "Task", description: "A task.", copiedFrom: null },
      TASK,
    );
  return { t, store, data, agents, app, seen };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
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

const newTask = (task = "Draft") => ({
  schemaId: "task",
  name: "Scene",
  description: "The scene.",
  value: { task },
});

describe("global data routes", () => {
  it("creates, lists, saves, deletes and restores, keeping every version", async () => {
    const { app, seen } = setup();
    const created = await api(app, "POST", "/api/global/data", newTask());
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(seen.map((e) => e.type)).toEqual(["data.changed"]);

    expect((await api(app, "GET", "/api/global/data")).body.data).toMatchObject(
      [{ id, name: "Scene", schemaVersion: 1 }],
    );
    expect(
      (
        await api(app, "PUT", `/api/global/data/${id}`, {
          name: "Scene 2",
          description: "d",
          value: { task: "Final", isDone: true },
        })
      ).status,
    ).toBe(200);
    expect((await api(app, "DELETE", `/api/global/data/${id}`)).status).toBe(
      204,
    );
    expect((await api(app, "GET", "/api/global/data")).body.data).toEqual([]);
    expect(
      (await api(app, "GET", "/api/global/data?deleted=true")).body.data,
    ).toMatchObject([{ id, deleted: true }]);

    const restored = await api(app, "POST", `/api/global/data/${id}/restore`, {
      seq: 1,
    });
    expect(restored.body).toMatchObject({
      name: "Scene",
      value: { task: "Draft" },
      deleted: false,
    });
    const detail = await api(app, "GET", `/api/global/data/${id}`);
    expect(
      (detail.body.versions as { seq: number; deleted: boolean }[]).map((v) => [
        v.seq,
        v.deleted,
      ]),
    ).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(detail.body.schema).toMatchObject({
      name: "Task",
      pinned: TASK,
      latest: TASK,
    });
  });

  it("refuses a value that does not match, with the reason", async () => {
    const { app } = setup();
    const res = await api(app, "POST", "/api/global/data", {
      ...newTask(),
      value: { isDone: 1 },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/missing required property 'task'/);
  });

  it("migrates out-of-date data to the latest version", async () => {
    const { app, data } = setup();
    const id = (await api(app, "POST", "/api/global/data", newTask())).body
      .id as string;
    data.shared({ projectId: null, agentId: null }).addSchemaVersion("task", {
      ...TASK,
      properties: { ...TASK.properties, priority: { type: "string" } },
      required: ["task", "priority"],
    });
    expect(
      (await api(app, "GET", `/api/global/data/${id}`)).body,
    ).toMatchObject({ outOfDate: true, latestVersion: 2 });
    const migrated = await api(app, "POST", `/api/global/data/${id}/migrate`, {
      value: { task: "Draft", priority: "high" },
    });
    expect(migrated.body).toMatchObject({ schemaVersion: 2, outOfDate: false });
  });

  it("lists the schemas whose data can be made in a scope", async () => {
    const { app, store, data } = setup();
    store.createProject({ id: "p1", name: "P", description: "", now: "T" });
    data
      .shared({ projectId: "p1", agentId: null })
      .createSchema(
        "project",
        { id: "ps", name: "Beat", description: "d", copiedFrom: null },
        TASK,
      );
    // Built-in schemas are offered everywhere; they're checked on their own.
    const names = async (url: string) =>
      (
        (await api(app, "GET", url)).body as unknown as {
          name: string;
          scope: string;
        }[]
      )
        .filter((s) => s.scope !== "builtin")
        .map((s) => s.name)
        .sort();
    expect(await names("/api/global/data/schemas")).toEqual(["Task"]);
    expect(await names("/api/projects/p1/data/schemas")).toEqual([
      "Beat",
      "Task",
    ]);
  });

  it("is read-only for a project in the trash", async () => {
    const { app, store } = setup();
    store.createProject({ id: "p1", name: "P", description: "", now: "T" });
    store.trashProject("p1", "T");
    const res = await api(app, "POST", "/api/projects/p1/data", newTask());
    expect(res.status).toBe(409);
  });
});

describe("session data routes", () => {
  it("records changes as edit messages the model reads", async () => {
    const { app, store } = setup();
    const session = (await api(app, "POST", "/api/sessions", {})).body
      .id as string;
    const created = await api(
      app,
      "POST",
      `/api/sessions/${session}/data`,
      newTask(),
    );
    expect(created.status).toBe(201);
    const messages = store.listMessages(session).map((m) => m.message);
    expect(messages).toMatchObject([
      {
        role: "edit",
        entries: [],
        dataOps: [{ op: "data_put", name: "Scene" }],
      },
    ]);
    expect(messages[0]?.role === "edit" && messages[0].content).toMatch(
      /changed session data "Scene"/,
    );
    const id = created.body.id as string;
    await api(app, "PUT", `/api/sessions/${session}/data/${id}`, {
      name: "Scene",
      description: "d",
      value: { task: "Final" },
    });
    expect(
      (await api(app, "GET", `/api/sessions/${session}/data/${id}`)).body,
    ).toMatchObject({
      value: { task: "Final" },
      versions: [
        { seq: 1, author: "user" },
        { seq: 2, author: "user" },
      ],
    });
  });
});

describe("schema routes (patch 4)", () => {
  it("creates, versions, deletes with its data, and restores both", async () => {
    const { app } = setup();
    const created = await api(app, "POST", "/api/global/schemas", {
      name: "Note",
      description: "A short note.",
      body: { type: "object", properties: { text: { type: "string" } } },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await api(app, "PUT", `/api/global/schemas/${id}`, {
      name: "Note",
      description: "A short note.",
      body: {
        type: "object",
        properties: { text: { type: "string" }, pinned: { type: "boolean" } },
      },
    });
    await api(app, "POST", "/api/global/data", {
      schemaId: id,
      name: "n",
      description: "d",
      value: { text: "hi" },
    });
    const detail = await api(app, "GET", `/api/global/schemas/${id}`);
    expect(detail.body).toMatchObject({ version: 2, dataCount: 1 });
    expect((detail.body.versions as unknown[]).length).toBe(2);

    expect(
      (await api(app, "DELETE", `/api/global/schemas/${id}`)).body,
    ).toEqual({ data: 1 });
    expect((await api(app, "GET", "/api/global/data")).body.data).toEqual([]);
    expect(
      (
        (await api(app, "GET", "/api/global/schemas?deleted=true")).body
          .schemas as { scope: string }[]
      ).filter((s) => s.scope !== "builtin"),
    ).toMatchObject([
      { id, name: "Note", deleted: true },
      { name: "Task", deleted: false },
    ]);
    await api(app, "POST", `/api/global/schemas/${id}/restore`);
    expect((await api(app, "GET", "/api/global/data")).body.data).toHaveLength(
      1,
    );
  });

  it("refuses an invalid schema with the reason", async () => {
    const { app } = setup();
    const res = await api(app, "POST", "/api/global/schemas", {
      name: "Bad",
      description: "d",
      body: { type: "object", propertys: {} },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/unsupported keyword "propertys"/);
  });

  it("copies a schema into a project or an agent", async () => {
    const { app, store, agents } = setup();
    store.createProject({ id: "p1", name: "P", description: "", now: "T" });
    const agent = agents.create(null, {
      name: "Editor",
      description: "",
      prompt: "",
      toolGrant: grant("allow", []),
      toolApproval: {},
    });
    const toProject = await api(app, "POST", "/api/global/schemas/task/copy", {
      to: { scope: "project", id: "p1" },
    });
    expect(toProject.status).toBe(201);
    expect(toProject.body).toMatchObject({
      scope: "project",
      name: "Task",
      version: 1,
      copiedFrom: "task",
    });
    const toAgent = await api(app, "POST", "/api/global/schemas/task/copy", {
      to: { scope: "agent", id: agent.id },
      name: "Chore",
    });
    expect(toAgent.body).toMatchObject({ scope: "agent", name: "Chore" });
    expect(
      (await api(app, "GET", `/api/agents/${agent.id}/schemas`)).body.schemas,
    ).toMatchObject([{ name: "Chore" }]);
  });

  it("keeps session schemas in the transcript", async () => {
    const { app, store } = setup();
    const session = (await api(app, "POST", "/api/sessions", {})).body
      .id as string;
    const created = await api(app, "POST", `/api/sessions/${session}/schemas`, {
      name: "Beat",
      description: "A story beat.",
      body: { type: "string" },
    });
    expect(created.status).toBe(201);
    expect(store.listMessages(session).map((m) => m.message)).toMatchObject([
      { role: "edit", dataOps: [{ op: "schema_put", name: "Beat" }] },
    ]);
    expect(
      (await api(app, "GET", `/api/sessions/${session}/schemas`)).body.schemas,
    ).toMatchObject([{ name: "Beat", scope: "session" }]);
  });
});
