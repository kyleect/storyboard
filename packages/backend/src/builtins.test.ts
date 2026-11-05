import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, type ChatRequest } from "@harness/core";
import {
  schemaDataTools,
  schemasInstruction,
  skillsInstruction,
  skillsList,
  skillTools,
} from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { DataStore } from "./data-store.js";
import { schemaChecker } from "./json-schema.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { SkillStore } from "./skills-store.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/* Built-in schemas and skills (schemas and data design, 45 to 52; P6, P7). */

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
  const data = new DataStore(t.db, schemaChecker);
  const skills = new SkillStore(t.db);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel([[{ type: "text", text: "Done" }]]);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [...schemaDataTools, ...skillTools],
    agents,
    skills,
    skillTools: skillTools.map((s) => s.name),
    skillsPrompt: skillsInstruction,
    skillsList,
    data,
    schemaChecker,
    dataTools: schemaDataTools.map((s) => s.name),
    schemasPrompt: schemasInstruction,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    skills,
    data,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, data, skills, runs, app, model };
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

describe("built-in schemas", () => {
  it("are added by the migration, valid, in the built-in scope", () => {
    const { data } = setup();
    const g = data.shared({ projectId: null, agentId: null });
    const builtins = g.listSchemas("builtin");
    expect(builtins.map((s) => [s.name, s.scope, s.version])).toEqual([
      ["Decision", "builtin", 1],
      ["Goal", "builtin", 1],
      ["Task", "builtin", 1],
    ]);
    expect(g.listSchemas("global")).toEqual([]);
    for (const s of builtins) {
      expect(schemaChecker.checkSchema(g.schemaBody(s.id, 1))).toEqual([]);
    }
    expect(g.schemaBody("builtin-task", 1)).toMatchObject({
      properties: {
        status: {
          enum: ["todo", "in_progress", "done", "blocked", "paused"],
          default: "todo",
        },
        blockedBy: { type: "string" },
      },
      required: ["title", "status"],
    });
    expect(g.schemaBody("builtin-goal", 1)).toMatchObject({
      properties: {
        status: {
          enum: ["active", "blocked", "paused", "achieved", "dropped"],
        },
        doneWhen: { type: "string" },
      },
      required: ["goal", "status"],
    });
    expect(g.schemaBody("builtin-decision", 1)).toMatchObject({
      required: ["question", "choice", "reason"],
    });
  });

  it("show on the global page, can't be changed, and can be copied", async () => {
    const { app } = setup();
    const list = (await api(app, "GET", "/api/global/schemas")).body
      .schemas as { name: string; scope: string }[];
    expect(list.map((s) => `${s.name}:${s.scope}`)).toEqual([
      "Decision:builtin",
      "Goal:builtin",
      "Task:builtin",
    ]);
    const edit = await api(app, "PUT", "/api/global/schemas/builtin-task", {
      name: "Task",
      description: "d",
      body: { type: "string" },
    });
    expect(edit.status).toBe(400);
    expect(String(edit.body.error)).toMatch(
      /Built-in schemas can't be changed/,
    );
    expect(
      (await api(app, "DELETE", "/api/global/schemas/builtin-task")).status,
    ).toBe(400);
    const copy = await api(
      app,
      "POST",
      "/api/global/schemas/builtin-task/copy",
      {
        to: { scope: "global" },
      },
    );
    // A global "Task" can sit beside the built-in one (plan P6).
    expect(copy.body).toMatchObject({
      name: "Task",
      scope: "global",
      copiedFrom: "builtin-task",
    });
  });

  it("make data in any data scope", async () => {
    const { app } = setup();
    const session = (await api(app, "POST", "/api/sessions", {})).body
      .id as string;
    for (const url of ["/api/global/data", `/api/sessions/${session}/data`]) {
      const res = await api(app, "POST", url, {
        schemaId: "builtin-decision",
        name: "Tense",
        description: "The story's tense.",
        value: {
          question: "What tense?",
          choice: "Past",
          reason: "It reads as a recollection.",
        },
      });
      expect(res.status).toBe(201);
    }
  });
});

describe("built-in skills", () => {
  it("are added by the migration and are in every run's scope", () => {
    const { skills } = setup();
    expect(skills.builtins().map((s) => [s.name, s.scope])).toEqual([
      ["decisions", "builtin"],
      ["goals", "builtin"],
      ["schemas-and-data", "builtin"],
      ["tasks", "builtin"],
    ]);
    expect(skills.list({ scope: "global" })).toEqual([]);
    expect(skills.inScope(null, null).map((s) => s.name)).toEqual([
      "decisions",
      "goals",
      "schemas-and-data",
      "tasks",
    ]);
  });

  it("show on the global page, can't be changed, and leave the name free", async () => {
    const { app, skills } = setup();
    const list = (await api(app, "GET", "/api/global/skills"))
      .body as unknown as {
      name: string;
    }[];
    expect(list.map((s) => s.name)).toContain("tasks");
    expect(
      (
        await api(app, "PUT", "/api/skills/builtin-tasks", {
          displayName: "Tasks",
          description: "d",
          body: "b",
        })
      ).status,
    ).toBe(409);
    expect((await api(app, "DELETE", "/api/skills/builtin-tasks")).status).toBe(
      409,
    );
    const mine = skills.create(
      { scope: "global" },
      { displayName: "Tasks", description: "Mine.", body: "My way." },
    );
    expect(mine.name).toBe("tasks");
  });
});

describe("built-ins in the system message (plan P7)", () => {
  it("lists the built-in schemas and skills", async () => {
    const { app, runs, model } = setup();
    const session = (await api(app, "POST", "/api/sessions", {})).body
      .id as string;
    const res = await api(app, "POST", `/api/sessions/${session}/messages`, {
      content: "Hi",
    });
    await expect
      .poll(() => runs.isActive(res.body.runId as string))
      .toBe(false);
    const system =
      (model.requests[0] as ChatRequest).messages.find(
        (m) => m.role === "system",
      )?.content ?? "";
    expect(system).toContain("- Task (id: builtin-task, builtin):");
    expect(system).toContain("- schemas-and-data:");
  });
});
