import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDataAccess,
  replaySessionData,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type ToolResultMessage,
} from "@harness/core";
import {
  dataText,
  schemaDataTools,
  schemasInstruction,
  schemasText,
  SKILL_LOAD,
} from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { DataStore } from "./data-store.js";
import { schemaChecker } from "./json-schema.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { grant, clearBuiltinAgents, tempDatabase } from "./test-helpers.js";
import { setToolAsks } from "./tool-settings.js";

/* Schemas and data (schemas and data design), patch 1. */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const TASK = {
  type: "object",
  properties: { task: { type: "string" }, isDone: { type: "boolean" } },
  required: ["task"],
};
const TASK_V2 = {
  type: "object",
  properties: {
    task: { type: "string" },
    isDone: { type: "boolean" },
    priority: { type: "string", enum: ["low", "high"] },
  },
  required: ["task", "priority"],
};

describe("schemaChecker (decision 18)", () => {
  it("accepts a supported schema and checks values with paths", () => {
    expect(schemaChecker.checkSchema(TASK)).toEqual([]);
    expect(schemaChecker.checkData(TASK, { task: "a" })).toEqual([]);
    expect(schemaChecker.checkData(TASK, { isDone: 1 })).toEqual([
      "(value): missing required property 'task'.",
      "/isDone: must be boolean.",
    ]);
  });

  it("checks formats and patterns", () => {
    const body = {
      type: "object",
      properties: {
        on: { type: "string", format: "date" },
        code: { type: "string", pattern: "^[A-Z]+$" },
      },
    };
    expect(schemaChecker.checkSchema(body)).toEqual([]);
    expect(schemaChecker.checkData(body, { on: "2026-11-04" })).toEqual([]);
    expect(
      schemaChecker.checkData(body, { on: "soon", code: "ab" }).length,
    ).toBe(2);
  });

  it("refuses unsupported keywords, a bad pattern and a default that does not match", () => {
    expect(
      schemaChecker.checkSchema({ type: "string", minLenght: 1 })[0],
    ).toMatch(/unsupported keyword "minLenght"/);
    expect(
      schemaChecker.checkSchema({ type: "string", pattern: "(" })[0],
    ).toMatch(/^\(schema\):/);
    expect(
      schemaChecker.checkSchema({
        type: "object",
        properties: { p: { type: "string", enum: ["a"], default: "b" } },
      }),
    ).toEqual([
      'properties.p: the default does not match: (value): must be one of "a".',
    ]);
  });
});

function stores() {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  const store = new Store(t.db);
  const data = new DataStore(t.db, schemaChecker);
  return { t, store, data };
}

describe("DataStore", () => {
  it("keeps scopes apart and names unique per scope", () => {
    const { t, store, data } = stores();
    store.createProject({ id: "p1", name: "P1", description: "", now: "T" });
    store.createProject({ id: "p2", name: "P2", description: "", now: "T" });
    const p1 = data.shared({ projectId: "p1", agentId: null });
    const p2 = data.shared({ projectId: "p2", agentId: null });
    p1.createSchema(
      "project",
      { id: "s1", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    p1.createSchema(
      "global",
      { id: "g1", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    expect(p1.nameTaken("project", "Task")).toBe(true);
    expect(p2.nameTaken("project", "Task")).toBe(false);
    expect(p2.getSchema("s1")).toBeUndefined();
    expect(p2.getSchema("g1")?.scope).toBe("global");
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO schemas (id, name, description, version, created_at, updated_at) VALUES ('x', 'Task', 'd', 1, 'T', 'T')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("bumps passing data on a new version and counts the rest (decision 11)", () => {
    const { data } = stores();
    const g = data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "s", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    const put = (id: string, value: unknown) =>
      g.putData(
        "global",
        {
          id,
          schemaId: "s",
          schemaVersion: 1,
          name: id,
          description: "d",
          value,
        },
        { by: "user" },
      );
    put("ok", { task: "a", priority: "low" });
    put("old", { task: "b" });
    expect(g.addSchemaVersion("s", TASK_V2)).toEqual({
      version: 2,
      bumped: 1,
      outOfDate: 1,
    });
    expect(g.getData("ok")?.schemaVersion).toBe(2);
    expect(g.getData("old")?.schemaVersion).toBe(1);
    expect(g.schemaBody("s", 1)).toEqual(TASK);
  });

  it("hides data while its schema is deleted (decision 14)", () => {
    const { data } = stores();
    const g = data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "s", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    g.putData(
      "global",
      {
        id: "d",
        schemaId: "s",
        schemaVersion: 1,
        name: "d",
        description: "d",
        value: { task: "a" },
      },
      { by: "user" },
    );
    g.deleteSchema("s");
    expect(g.listSchemas("global")).toEqual([]);
    expect(g.listData("global")).toEqual([]);
  });

  it("is removed with its project", () => {
    const { t, store, data } = stores();
    store.createProject({ id: "p1", name: "P1", description: "", now: "T" });
    const p = data.shared({ projectId: "p1", agentId: null });
    p.createSchema(
      "project",
      { id: "s", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    p.putData(
      "project",
      {
        id: "d",
        schemaId: "s",
        schemaVersion: 1,
        name: "d",
        description: "d",
        value: { task: "a" },
      },
      { by: "user" },
    );
    store.purgeProject("p1");
    // The built-in schemas stay.
    const count = (table: string) =>
      (
        t.db
          .prepare(
            table.startsWith("schema")
              ? `SELECT count(*) AS n FROM ${table} WHERE ${table === "schemas" ? "id" : "schema_id"} NOT LIKE 'builtin-%'`
              : `SELECT count(*) AS n FROM ${table}`,
          )
          .get() as { n: number }
      ).n;
    expect(
      ["schemas", "schema_versions", "data", "data_versions"].map(count),
    ).toEqual([0, 0, 0, 0]);
  });
});

describe("where data may live (decisions 6, 6a, 6b)", () => {
  function access(
    projectId: string | null,
    agentProject: string | null | undefined,
  ) {
    const { t, store, data } = stores();
    store.createProject({ id: "p1", name: "P1", description: "", now: "T" });
    const agent =
      agentProject === undefined
        ? null
        : new AgentStore(t.db).create(agentProject, {
            name: "Editor",
            description: "",
            prompt: "",
            toolGrant: grant("allow", []),
            toolApproval: {},
          });
    return createDataAccess({
      session: replaySessionData([]),
      sessionOps: [],
      shared: data.shared({ projectId, agentId: agent?.id ?? null }),
      checker: schemaChecker,
      projectId,
      agent: agent ? { id: agent.id, projectId: agent.projectId } : null,
      author: { by: "user" },
    });
  }
  const allowed = (
    a: ReturnType<typeof access>,
    schemaScope: "global" | "project" | "agent" | "session",
  ) => {
    const schema = a.createSchema({
      scope: schemaScope,
      name: `T-${schemaScope}`,
      description: "d",
      body: TASK,
    });
    return a.scopes.filter((scope) => {
      try {
        a.createData({
          scope,
          schemaId: schema.id,
          name: "x",
          description: "d",
          value: { task: "x" },
        });
        return true;
      } catch {
        return false;
      }
    });
  };

  it("a project agent's run", () => {
    const a = access("p1", "p1");
    expect(a.scopes).toEqual(["session", "project", "agent", "global"]);
    expect(allowed(a, "global")).toEqual([
      "session",
      "project",
      "agent",
      "global",
    ]);
    expect(allowed(a, "project")).toEqual(["session", "project", "agent"]);
    expect(allowed(a, "agent")).toEqual(["session", "agent"]);
    expect(allowed(a, "session")).toEqual(["session"]);
  });

  it("a global agent in a project: no agent data from project schemas", () => {
    const a = access("p1", null);
    expect(allowed(a, "project")).toEqual(["session", "project"]);
  });
});

// ---- Runs -------------------------------------------------------------------

async function setup(scripts: ScriptStep[][], ask = false) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const agents = new AgentStore(t.db, now);
  const data = new DataStore(t.db, schemaChecker, now);
  if (!ask) for (const tool of schemaDataTools) setToolAsks(t.db, tool, false);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: schemaDataTools,
    agents,
    data,
    schemaChecker,
    dataTools: schemaDataTools.map((x) => x.name),
    schemasPrompt: schemasInstruction,
    schemasList: schemasText,
    dataList: dataText,
    now,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, data, runs, app, model };
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

const call = (name: string, args: unknown, callId = name): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const answer: ScriptStep[] = [{ type: "text", text: "Done" }];
const systemOf = (r: unknown) =>
  (r as ChatRequest).messages.find((m) => m.role === "system")?.content;

async function say(
  s: { app: FastifyInstance; runs: RunManager },
  session: string,
) {
  const res = await api(s.app, "POST", `/api/sessions/${session}/messages`, {
    content: "Hi",
  });
  await expect
    .poll(() => s.runs.isActive(res.body.runId as string))
    .toBe(false);
}

const results = (store: Store, session: string) =>
  store
    .listMessages(session)
    .map((m) => m.message)
    .filter((m): m is ToolResultMessage => m.role === "tool");

describe("schemas and data in runs", () => {
  it("creates schemas and session data through the tools; session data stays in the transcript", async () => {
    const s = await setup([
      [
        call("schema_create", {
          scope: "global",
          name: "Chore",
          description: "Something to do.",
          schema: TASK,
        }),
      ],
      [
        call("data_create", {
          schemaId: "g1",
          scope: "session",
          name: "Scene 2",
          description: "Draft scene 2.",
          value: { task: "Draft scene 2" },
        }),
      ],
      [call("data_list", {})],
      [call("schemas_list", {})],
      answer,
    ]);
    s.data
      .shared({ projectId: null, agentId: null })
      .createSchema(
        "global",
        { id: "g1", name: "Task", description: "A task.", copiedFrom: null },
        TASK,
      );
    const session = (await api(s.app, "POST", "/api/sessions", {})).body
      .id as string;
    await say(s, session);
    const [schema, create, list, schemas] = results(s.store, session);
    expect(schema?.isError).toBe(false);
    expect(create?.isError).toBe(false);
    expect(create?.dataOps?.map((o) => o.op)).toEqual(["data_put"]);
    expect(JSON.parse(list?.content ?? "")).toMatchObject({
      data: [{ name: "Scene 2", scope: "session", schemaVersion: 1 }],
    });
    expect(
      (
        JSON.parse(schemas?.content ?? "") as {
          schemas: { name: string; scope: string }[];
        }
      ).schemas
        .filter((x) => x.scope !== "builtin")
        .map((x) => x.name)
        .sort(),
    ).toEqual(["Chore", "Task"]);
    // Session data lives in the transcript only (decision 4).
    expect(
      (s.t.db.prepare("SELECT count(*) AS n FROM data").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("lists the schemas in scope in the system message, after the prompts", async () => {
    const s = await setup([answer]);
    s.data
      .shared({ projectId: null, agentId: null })
      .createSchema(
        "global",
        { id: "g1", name: "Task", description: "A task.", copiedFrom: null },
        TASK,
      );
    writeSettings(s.t.db, { systemPrompt: "G" });
    await say(
      s,
      (await api(s.app, "POST", "/api/sessions", {})).body.id as string,
    );
    const system = systemOf(s.model.requests[0]);
    expect(system).toMatch(/^G\n\nYou have schemas:/);
    // The built-in Task has the same name, so the scope is shown.
    expect(system).toContain("- Task (global): A task.");
  });

  it("puts the list where {{schemas}} is written, once, without the introduction", async () => {
    const s = await setup([answer]);
    s.data
      .shared({ projectId: null, agentId: null })
      .createSchema(
        "global",
        { id: "g1", name: "Task", description: "A task.", copiedFrom: null },
        TASK,
      );
    writeSettings(s.t.db, {
      systemPrompt: "<schemas>\n{{schemas}}\n</schemas>",
    });
    await say(
      s,
      (await api(s.app, "POST", "/api/sessions", {})).body.id as string,
    );
    const system = systemOf(s.model.requests[0]) ?? "";
    expect(system.startsWith("<schemas>\n- ")).toBe(true);
    expect(system).toContain("\n- Task (global): A task.\n");
    expect(system).not.toContain("You have schemas:");
  });

  it("lists data as schema name, data name and description where {{data}} is written", async () => {
    const s = await setup([
      [
        call("data_create", {
          schemaId: "g1",
          scope: "session",
          name: "Scene 2",
          description: "Draft scene 2.",
          value: { task: "Draft scene 2" },
        }),
      ],
      answer,
      answer,
    ]);
    const g = s.data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "g1", name: "Scene", description: "A scene.", copiedFrom: null },
      TASK,
    );
    g.putData(
      "global",
      {
        id: "d1",
        schemaId: "g1",
        schemaVersion: 1,
        name: "Chapter 1",
        description: "Plan chapter 1.",
        value: { task: "Plan chapter 1" },
      },
      { by: "user" },
    );
    writeSettings(s.t.db, {
      systemPrompt: "<data>\n{{ data }}\n</data>",
    });
    const session = (await api(s.app, "POST", "/api/sessions", {})).body
      .id as string;
    await say(s, session);
    // The system message is built once per run: the first run sees the
    // global data, and the next one the session's data as well.
    expect(
      systemOf(s.model.requests[0])?.startsWith(
        "<data>\n- Scene: Chapter 1 - Plan chapter 1.\n</data>",
      ),
    ).toBe(true);
    await say(s, session);
    expect(
      systemOf(s.model.requests[2])?.startsWith(
        "<data>\n- Scene: Chapter 1 - Plan chapter 1.\n- Scene: Scene 2 - Draft scene 2.\n</data>",
      ),
    ).toBe(true);
  });

  it("leaves data out when its schema is deleted, and expands {{data}} to nothing with none", async () => {
    const s = await setup([answer]);
    const g = s.data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "g1", name: "Scene", description: "A scene.", copiedFrom: null },
      TASK,
    );
    g.putData(
      "global",
      {
        id: "d1",
        schemaId: "g1",
        schemaVersion: 1,
        name: "Chapter 1",
        description: "d",
        value: { task: "a" },
      },
      { by: "user" },
    );
    g.deleteSchema("g1");
    writeSettings(s.t.db, { systemPrompt: "A{{data}}B" });
    await say(
      s,
      (await api(s.app, "POST", "/api/sessions", {})).body.id as string,
    );
    const system = systemOf(s.model.requests[0]) ?? "";
    expect(system.startsWith("AB\n\n")).toBe(true);
    expect(system).not.toContain("Chapter 1");
  });

  it("leaves the list out when the run offers no schema or data tool", async () => {
    const s = await setup([answer]);
    s.data
      .shared({ projectId: null, agentId: null })
      .createSchema(
        "global",
        { id: "g1", name: "Task", description: "A task.", copiedFrom: null },
        TASK,
      );
    writeSettings(s.t.db, { systemPrompt: "G" });
    const agent = s.agents.create(null, {
      name: "Plain",
      description: "",
      prompt: "",
      toolGrant: grant("allow", [SKILL_LOAD]),
      toolApproval: {},
    });
    const session = (await api(s.app, "POST", "/api/sessions", {})).body
      .id as string;
    const res = await api(s.app, "POST", `/api/sessions/${session}/messages`, {
      content: "Hi",
      agentId: agent.id,
    });
    await expect
      .poll(() => s.runs.isActive(res.body.runId as string))
      .toBe(false);
    expect(systemOf(s.model.requests[0])).toBe("G");
  });

  it("asks before writes and not before reads by default (decision 36)", () => {
    const asks = Object.fromEntries(
      schemaDataTools.map((t) => [t.name, t.approval]),
    );
    expect(asks).toEqual({
      schemas_list: "never",
      schema_view: "never",
      schema_create: "ask",
      schema_update: "ask",
      schema_copy: "ask",
      schema_delete: "ask",
      data_list: "never",
      data_view: "never",
      data_create: "ask",
      data_update: "ask",
      data_migrate: "ask",
      data_migrate_many: "ask",
      data_delete: "ask",
    });
  });

  it("warns about out-of-date data and migrates it, singly and in a batch", async () => {
    const s = await setup([
      [call("data_view", { id: "a" })],
      [call("data_migrate", { id: "a", patch: { priority: "low" } })],
      [
        call("data_migrate_many", {
          items: [{ id: "b", patch: { priority: "high" } }, { id: "nope" }],
        }),
      ],
      answer,
    ]);
    const g = s.data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "s", name: "Task", description: "d", copiedFrom: null },
      TASK,
    );
    for (const id of ["a", "b"]) {
      g.putData(
        "global",
        {
          id,
          schemaId: "s",
          schemaVersion: 1,
          name: id,
          description: "d",
          value: { task: id },
        },
        { by: "user" },
      );
    }
    g.addSchemaVersion("s", TASK_V2);
    const session = (await api(s.app, "POST", "/api/sessions", {})).body
      .id as string;
    await say(s, session);
    const [view, migrate, many] = results(s.store, session).map(
      (m) => JSON.parse(m.content) as Record<string, unknown>,
    );
    expect(view).toMatchObject({ outOfDate: true, schemaVersion: 1 });
    expect(String(view?.warning)).toMatch(
      /missing required property 'priority'/,
    );
    expect(migrate).toMatchObject({
      migrated: { schemaVersion: 2, value: { task: "a", priority: "low" } },
    });
    expect(many).toMatchObject({
      results: [
        { id: "b", migrated: { schemaVersion: 2 } },
        { id: "nope", error: expect.stringMatching(/No data/) },
      ],
    });
    expect(g.getData("b")?.schemaVersion).toBe(2);
  });
});

describe("approval prompts with changes (plan P5; decisions 30 to 35)", () => {
  async function asking(steps: ScriptStep[][]) {
    const s = await setup([...steps, answer], true);
    const g = s.data.shared({ projectId: null, agentId: null });
    g.createSchema(
      "global",
      { id: "s", name: "Task", description: "d", copiedFrom: null },
      TASK_V2,
    );
    g.putData(
      "global",
      {
        id: "d1",
        schemaId: "s",
        schemaVersion: 1,
        name: "Scene",
        description: "d",
        value: { task: "draft", priority: "low" },
      },
      { by: "user" },
    );
    const session = (await api(s.app, "POST", "/api/sessions", {})).body
      .id as string;
    const res = await api(s.app, "POST", `/api/sessions/${session}/messages`, {
      content: "Hi",
    });
    const runId = res.body.runId as string;
    await expect
      .poll(() => s.runs.snapshot(session).activeRun?.approvals.length)
      .toBe(1);
    const request = s.runs.snapshot(session).activeRun?.approvals[0];
    if (!request) throw new Error("No approval.");
    const done = () => expect.poll(() => s.runs.isActive(runId)).toBe(false);
    return { s, g, session, runId, request, done };
  }
  const update = call("data_update", {
    id: "d1",
    patch: { task: "final", isDone: true },
  });

  it("shows the changed fields and applies only the approved ones", async () => {
    const { s, g, session, runId, request, done } = await asking([[update]]);
    expect(request.review?.items[0]?.changes.map((c) => c.path)).toEqual([
      "/value/task",
      "/value/isDone",
    ]);
    s.runs.answerApproval(runId, request.requestId, {
      choice: "once",
      selection: { data: ["/value/isDone"] },
    });
    await done();
    expect(g.getData("d1")?.value).toEqual({
      task: "draft",
      priority: "low",
      isDone: true,
    });
    const result = JSON.parse(results(s.store, session)[0]?.content ?? "");
    expect(result).toMatchObject({
      applied: ["/value/isDone"],
      rejected: ["/value/task"],
      updated: { value: { task: "draft", isDone: true } },
    });
  });

  it("applies everything with Approve all (once, no selection)", async () => {
    const { s, g, runId, request, done } = await asking([[update]]);
    s.runs.answerApproval(runId, request.requestId, { choice: "once" });
    await done();
    expect(g.getData("d1")?.value).toMatchObject({
      task: "final",
      isDone: true,
    });
  });

  it("refuses a selection that fails the schema (decision 33)", async () => {
    const create = call("data_create", {
      schemaId: "s",
      scope: "global",
      name: "New",
      description: "d",
      value: { task: "t", priority: "high" },
    });
    const { s, runId, request, done } = await asking([[create]]);
    expect(request.review?.items[0]).toMatchObject({ showValue: true });
    const without = {
      data: ["/name", "/description", "/value/task"],
    };
    expect(
      s.runs.checkApproval(runId, request.requestId, without).errors.join(),
    ).toMatch(/priority/);
    expect(() =>
      s.runs.answerApproval(runId, request.requestId, {
        choice: "once",
        selection: without,
      }),
    ).toThrow(/cannot be applied/);
    expect(() =>
      s.runs.answerApproval(runId, request.requestId, {
        choice: "session",
        selection: without,
      }),
    ).toThrow(/only be picked one by one with once/);
    s.runs.answerApproval(runId, request.requestId, { choice: "deny" });
    await done();
  });

  it("flags a change that went stale and refreshes it (decision 30)", async () => {
    const { s, g, runId, request, done } = await asking([[update]]);
    g.putData(
      "global",
      {
        id: "d1",
        schemaId: "s",
        schemaVersion: 1,
        name: "Scene",
        description: "d",
        value: { task: "edited elsewhere", priority: "high" },
      },
      { by: "user" },
    );
    expect(s.runs.checkApproval(runId, request.requestId)).toEqual({
      errors: [],
      stale: true,
    });
    expect(() =>
      s.runs.answerApproval(runId, request.requestId, { choice: "once" }),
    ).toThrow(/changed since this was asked/);
    const fresh = s.runs.refreshApproval(runId, request.requestId);
    expect(fresh.review?.items[0]?.changes[0]).toMatchObject({
      path: "/value/task",
      before: "edited elsewhere",
      after: "final",
    });
    s.runs.answerApproval(runId, request.requestId, { choice: "once" });
    await done();
    expect(g.getData("d1")?.value).toEqual({
      task: "final",
      priority: "high",
      isDone: true,
    });
  });

  it("reviews a schema update field by field", async () => {
    const { s, g, runId, request, done } = await asking([
      [
        call("schema_update", {
          id: "s",
          name: "Chore",
          schema: { ...TASK_V2, required: ["task"] },
        }),
      ],
    ]);
    expect(request.review?.items[0]?.changes.map((c) => c.path)).toEqual([
      "/name",
      "/schema/required/1",
    ]);
    s.runs.answerApproval(runId, request.requestId, {
      choice: "once",
      selection: { schema: ["/name"] },
    });
    await done();
    expect(g.getSchema("s")).toMatchObject({ name: "Chore", version: 1 });
  });

  it("goes through the routes", async () => {
    const { s, runId, request, done } = await asking([[update]]);
    const base = `/api/runs/${runId}/approvals/${request.requestId}`;
    expect(
      (await api(s.app, "POST", `${base}/check`, { selection: { data: [] } }))
        .body,
    ).toEqual({ errors: [], stale: false });
    expect(
      (await api(s.app, "POST", `${base}/refresh`)).body.request,
    ).toMatchObject({ requestId: request.requestId });
    expect(
      (
        await api(s.app, "POST", base, {
          choice: "once",
          selection: { data: ["/value/task"] },
        })
      ).status,
    ).toBe(200);
    await done();
  });
});
