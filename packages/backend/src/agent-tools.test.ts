import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaySessionData,
  replaySessionFiles,
  ScriptedModel,
  type ChatRequest,
  type DataOp,
  type FileOp,
  type Form,
  type ScriptStep,
} from "@harness/core";
import { allTools, filesInstruction } from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { putBlob } from "./blobs.js";
import type { AppEvent } from "./app-events.js";
import { DataStore } from "./data-store.js";
import { BUILTIN_DISPATCHER } from "./default-agent.js";
import { FileStore } from "./files-store.js";
import { schemaChecker } from "./json-schema.js";
import { SkillStore } from "./skills-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { grant, clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/*
 * The copy, move, project and agent tools (agent tools design), driven
 * through real runs: every call asks for approval (except the two list
 * tools) and most show one form.
 */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(
  options: {
    /** Schemas and data reach the tools (the session's can be copied). */
    data?: boolean;
    /** Keep the built-in Dispatcher, so new sessions start with it. */
    dispatcher?: boolean;
  } = {},
) {
  // Tests add scripts after creating what they refer to (ids, for example).
  const scripts: ScriptStep[][] = [];
  const t = tempDatabase();
  if (!options.dispatcher) clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let clock = 0;
  const now = () =>
    new Date(Date.UTC(2026, 10, 2, 0, 0, ++clock))
      .toISOString()
      .replace(".000Z", "Z");
  const files = new FileStore(t.db, now);
  const agents = new AgentStore(t.db, now);
  const data = new DataStore(t.db, schemaChecker, now);
  const skills = new SkillStore(t.db, now);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    agents,
    files,
    ...(options.data ? { data, schemaChecker, skills } : {}),
    systemPrompt: (s) => filesInstruction(s.project_id !== null),
    now,
  });
  const seen: AppEvent[] = [];
  // Not `runs.changed` (active-runs.test.ts): it comes with every run, and
  // these tests look for the events a tool's change announces.
  runs.events.subscribe((e) => {
    if (e.type !== "runs.changed") seen.push(e);
  });
  const app = buildServer({ store, runs, files, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return {
    t,
    store,
    runs,
    app,
    model,
    files,
    agents,
    data,
    skills,
    seen,
    scripts,
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (res.body ? res.json() : undefined) as any,
  };
}

async function newSession(app: FastifyInstance, projectId?: string) {
  const { body } = await api(app, "POST", "/api/sessions", {
    title: "T",
    ...(projectId ? { projectId } : {}),
  });
  return body.id as string;
}

async function newProject(app: FastifyInstance, name = "P") {
  const { body } = await api(app, "POST", "/api/projects", { name });
  return body.id as string;
}

/** An answer to a form: its answers, or null to skip it. */
type FormAnswer = Record<string, unknown> | null;

/**
 * Sends a message and waits for the run. Each approval is answered `once`
 * (or by the next of `decisions`), each form by the next of `forms`.
 */
async function go(
  c: Ctx,
  sessionId: string,
  options: {
    forms?: FormAnswer[];
    decisions?: ("once" | "deny")[];
  } = {},
) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content: "Go",
  });
  expect(res.status).toBe(202);
  const runId = res.body.runId as string;
  const forms = [...(options.forms ?? [])];
  const decisions = [...(options.decisions ?? [])];
  const shown: Form[] = [];
  const deadline = Date.now() + 5000;
  while (c.runs.isActive(runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end in time.");
    const open = c.runs.snapshot(sessionId).activeRun;
    const approval = open?.approvals[0];
    if (approval) {
      c.runs.answerApproval(runId, approval.requestId, {
        choice: decisions.shift() ?? "once",
      });
    }
    const input = open?.inputs[0];
    if (input) {
      shown.push(input.form);
      if (forms.length === 0)
        throw new Error("A form was shown with no answer.");
      const next = forms.shift() ?? null;
      c.runs.answerInput(
        runId,
        input.requestId,
        next ? { outcome: "answered", answers: next } : { outcome: "skipped" },
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return { runId, shown };
}

const call = (callId: string, name: string, args: object = {}): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const done: ScriptStep[] = [{ type: "text", text: "Done" }];

/** The result data of the session's tool calls, in order. */
function results(c: Ctx, sessionId: string) {
  return c.store
    .listMessages(sessionId)
    .map((m) => m.message)
    .flatMap((m) =>
      m.role === "tool"
        ? [{ name: m.name, isError: m.isError, data: m.data }]
        : [],
    );
}

/** Puts files in a session's scope, as the user editing them. */
function seedSession(c: Ctx, sessionId: string, ops: FileOp[]) {
  c.runs.editSessionFiles(sessionId, ops);
}
const file = (key: string, value: string): FileOp => ({
  op: "put",
  key,
  mediaType: "text/markdown",
  value,
});
const agentContent = (name: string) => ({
  name,
  description: `${name} agent`,
  prompt: `You are ${name}.`,
  toolGrant: grant("deny", ["web_search"]),
  toolApproval: {},
});

describe("agents_list and agent_view", () => {
  it("lists the agents that can do work for the run, with their scope", async () => {
    const c = await setup();
    const projectId = await newProject(c.app, "Ashfall");
    const other = await newProject(c.app, "Other");
    c.agents.create(projectId, { ...agentContent("Editor"), subagent: true });
    c.agents.create(null, { ...agentContent("Critic"), subagent: true });
    // Not startable, and not this session's: neither is listed.
    c.agents.create(null, agentContent("Muse"));
    c.agents.create(other, {
      ...agentContent("Elsewhere"),
      subagent: true,
    });
    const id = await newSession(c.app, projectId);
    c.scripts.push([call("a", "agents_list")], done);

    await go(c, id);
    const [list] = results(c, id);
    expect(list?.isError).toBe(false);
    const agents = (list?.data as { agents: Record<string, unknown>[] }).agents;
    expect(agents.map((a) => a["name"])).toEqual(["Editor", "Critic"]);
    expect(agents[0]).toMatchObject({
      scope: "project",
      project: "Ashfall",
      description: "Editor agent",
      toolMode: "deny",
      // Tools that change something are denied unless the agent lists them
      // (tool management design), so the workspace ones show here.
      tools: [
        "web_search",
        "workspace_write",
        "workspace_edit",
        "workspace_move",
        "workspace_delete",
        "workspace_folder_create",
        "workspace_folder_rename",
        "workspace_folder_delete",
      ],
    });
    expect(agents[1]).toMatchObject({ scope: "global" });
    expect(agents[1]).not.toHaveProperty("project");
    // Everything listed is startable, so there is no flag to read.
    expect(agents[0]).not.toHaveProperty("subagent");
  });

  it("leaves the run's own agent out of the list, and refuses to start it", async () => {
    const c = await setup();
    const editor = c.agents.create(null, {
      ...agentContent("Editor"),
      subagent: true,
    });
    c.agents.create(null, { ...agentContent("Critic"), subagent: true });
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push(
      [call("a", "agents_list")],
      [call("s", "start_subagent", { agentId: editor.id, task: "Again" })],
      done,
    );

    await go(c, id);
    const [list, start] = results(c, id);
    const agents = (list?.data as { agents: Record<string, unknown>[] }).agents;
    expect(agents.map((a) => a["name"])).toEqual(["Critic"]);
    expect(start?.isError).toBe(true);
    expect(JSON.stringify(start?.data)).toContain("cannot start itself");
  });

  it("agent_view says when there is no agent", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    c.scripts.push([call("a", "agent_view")], done);
    await go(c, id);
    expect(results(c, id)[0]?.data).toEqual({
      agent: null,
      guidance: "This run has no agent.",
    });
  });

  it("agent_view shows the run's agent, its version and prompt", async () => {
    const c = await setup();
    const editor = c.agents.create(null, agentContent("Editor"));
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push([call("a", "agent_view")], done);
    await go(c, id);
    expect(results(c, id)[0]?.data).toMatchObject({
      agent: { name: "Editor", version: 1, prompt: "You are Editor." },
    });
    expect(results(c, id)[0]?.data).not.toHaveProperty("pendingChange");
  });

  it("no longer has an agent_change tool", () => {
    expect(allTools.map((t) => t.name)).not.toContain("agent_change");
  });
});

describe("projects_list, project_view and project_create", () => {
  it("lists projects that are not in the trash", async () => {
    const c = await setup();
    const a = await newProject(c.app, "Beta");
    await newProject(c.app, "Alpha");
    const gone = await newProject(c.app, "Gone");
    c.store.trashProject(gone, "2026-11-02T00:00:00Z");
    const id = await newSession(c.app);
    c.scripts.push([call("a", "projects_list")], done);

    await go(c, id);
    const { projects } = results(c, id)[0]?.data as {
      projects: { id: string; name: string; description: string }[];
    };
    expect(projects.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    expect(projects[1]).toEqual({ id: a, name: "Beta", description: "" });
  });

  it("shows the session's project, or says there is none", async () => {
    const c = await setup();
    const projectId = await newProject(c.app, "Ashfall");
    const editor = c.agents.create(null, agentContent("Editor"));
    c.store.updateProject(projectId, {
      description: "A story",
      systemPrompt: "Be brief.",
      defaultAgentId: editor.id,
    });
    const inside = await newSession(c.app, projectId);
    const outside = await newSession(c.app);
    c.scripts.push([call("a", "project_view")], done);
    c.scripts.push([call("b", "project_view")], done);

    await go(c, inside);
    await go(c, outside);
    expect(results(c, inside)[0]?.data).toEqual({
      project: {
        id: projectId,
        name: "Ashfall",
        description: "A story",
        defaultAgent: "Editor",
        systemPrompt: "Be brief.",
      },
    });
    expect(results(c, outside)[0]?.data).toEqual({
      project: null,
      guidance: "This session is not in a project.",
    });
  });

  it("creates a project with no agent from the session, copying what was ticked", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("topics.md", "Topics")]);
    c.scripts.push([call("a", "project_create", { name: "Research" })], done);

    const { shown } = await go(c, id, {
      forms: [
        {
          name: "Research topics",
          description: "Looking things up",
          systemPrompt: "You research.",
          copyFiles: true,
        },
      ],
    });

    // The form suggested the name and offered the copy, ticked.
    expect(shown[0]?.fields.map((f) => f.name)).toEqual([
      "name",
      "description",
      "systemPrompt",
      "copyFiles",
    ]);
    expect(shown[0]?.fields[0]).toMatchObject({ default: "Research" });
    expect(shown[0]?.fields[3]).toMatchObject({
      kind: "boolean",
      default: true,
    });

    const created = c.store
      .listProjects()
      .find((p) => p.name === "Research topics");
    expect(created).toMatchObject({
      description: "Looking things up",
      system_prompt: "You research.",
      default_agent_id: null,
    });
    expect(results(c, id)[0]?.data).toEqual({
      project: { id: created?.id, name: "Research topics" },
      filesCopied: 1,
    });
    expect(
      c.files.list(created?.id ?? "").map((e) => [e.key, e.value]),
    ).toEqual([["topics.md", "Topics"]]);
    // The session stays where it is, and windows are told.
    expect(c.store.getSession(id)?.project_id).toBeNull();
    expect(c.seen).toContainEqual({
      type: "projects.changed",
      data: { projectId: created?.id },
    });
  });

  it("creates nothing when the form is skipped", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    c.scripts.push([call("a", "project_create", { name: "Nope" })], done);

    await go(c, id, { forms: [null] });
    expect(c.store.listProjects()).toEqual([]);
    expect(results(c, id)[0]).toMatchObject({
      isError: true,
      data: "Not created: the user chose not to create a project.",
    });
    expect(c.seen).toEqual([]);
  });
});

/** A schema with two versions: data on the first does not pass the second. */
const BEAT_V1 = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};
const BEAT_V2 = {
  type: "object",
  properties: { title: { type: "string" }, beat: { type: "string" } },
  required: ["title", "beat"],
};

/** The session's schemas and data, as the user editing them. */
function seedData(c: Ctx, sessionId: string, ops: DataOp[]) {
  c.runs.editSessionData(sessionId, ops);
}

/**
 * A two-version session schema, data on its first version that does not pass
 * the second, and data made from a built-in schema.
 */
function seedBeats(c: Ctx, sessionId: string) {
  const schema = { name: "Beat", description: "A story beat" };
  seedData(c, sessionId, [
    { op: "schema_put", id: "s-beat", ...schema, version: 1, body: BEAT_V1 },
    { op: "schema_put", id: "s-beat", ...schema, version: 2, body: BEAT_V2 },
    {
      op: "data_put",
      id: "d-open",
      schemaId: "s-beat",
      schemaVersion: 1,
      name: "Opening",
      description: "First beat",
      value: { title: "Dawn" },
    },
    {
      op: "data_put",
      id: "d-todo",
      schemaId: "builtin-task",
      schemaVersion: 1,
      name: "Draft",
      description: "Write it",
      value: { task: "Write" },
    },
  ]);
}

describe("project_create: structured data and the agent", () => {
  it("offers structured data and the agent, with what each holds", async () => {
    const c = await setup({ data: true });
    const editor = c.agents.create(null, agentContent("Editor"));
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    seedData(c, id, [
      {
        op: "schema_put",
        id: "s-beat",
        name: "Beat",
        description: "A story beat",
        version: 1,
        body: BEAT_V1,
      },
      {
        op: "data_put",
        id: "d-open",
        schemaId: "s-beat",
        schemaVersion: 1,
        name: "Opening",
        description: "First beat",
        value: { title: "Dawn" },
      },
    ]);
    c.scripts.push([call("a", "project_create")], done);

    const { shown } = await go(c, id, {
      forms: [{ name: "Ashfall", copyData: false, copyAgent: false }],
    });

    expect(shown[0]?.fields.map((f) => f.name)).toEqual([
      "name",
      "description",
      "systemPrompt",
      "copyData",
      "copyAgent",
    ]);
    expect(shown[0]?.fields[3]).toMatchObject({
      kind: "boolean",
      default: true,
      label:
        "Copy this session's structured data (1 schema and 1 piece of data)",
    });
    expect(shown[0]?.fields[4]).toMatchObject({
      kind: "boolean",
      default: true,
      label: 'Copy the agent this session is using ("Editor")',
    });
    expect(shown[0]?.description).toBe("This session stays where it is.");
  });

  it("copies schemas with every version, and data on the version it is pinned to", async () => {
    const c = await setup({ data: true });
    const id = await newSession(c.app);
    seedBeats(c, id);
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Ashfall", description: "", systemPrompt: "", copyData: true },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    const shared = c.data.shared({
      projectId: created?.id ?? "",
      agentId: null,
    });
    const schemas = shared.listSchemas("project");
    expect(schemas).toMatchObject([
      {
        name: "Beat",
        description: "A story beat",
        version: 2,
        scope: "project",
      },
    ]);
    const beat = schemas[0];
    expect(shared.schemaBody(beat?.id ?? "", 1)).toEqual(BEAT_V1);
    expect(shared.schemaBody(beat?.id ?? "", 2)).toEqual(BEAT_V2);
    expect(
      shared.listData("project").map((d) => ({
        name: d.name,
        schemaId: d.schemaId,
        schemaVersion: d.schemaVersion,
        value: d.value,
      })),
    ).toEqual([
      // A built-in schema stays where it is: the data keeps using it.
      {
        name: "Draft",
        schemaId: "builtin-task",
        schemaVersion: 1,
        value: { task: "Write" },
      },
      // Did not pass version 2, so it stays pinned to version 1.
      {
        name: "Opening",
        schemaId: beat?.id,
        schemaVersion: 1,
        value: { title: "Dawn" },
      },
    ]);
    expect(results(c, id)[0]?.data).toMatchObject({
      project: { name: "Ashfall" },
      schemasCopied: 1,
      dataCopied: 2,
    });
    // The session's own are still there.
    const session = replaySessionData(
      c.store.listMessages(id).map((m) => m.message),
    );
    expect([...session.schemas.keys()]).toEqual(["s-beat"]);
    expect([...session.data.keys()]).toEqual(["d-open", "d-todo"]);
  });

  it("copies no schemas or data when that is not ticked", async () => {
    const c = await setup({ data: true });
    const id = await newSession(c.app);
    seedBeats(c, id);
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Ashfall", description: "", systemPrompt: "", copyData: false },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    const shared = c.data.shared({
      projectId: created?.id ?? "",
      agentId: null,
    });
    expect(shared.listSchemas("project")).toEqual([]);
    expect(shared.listData("project")).toEqual([]);
    expect(results(c, id)[0]?.data).not.toHaveProperty("schemasCopied");
  });

  it("brings along the project schema that session data uses, renaming a clash", async () => {
    const c = await setup({ data: true });
    const from = await newProject(c.app, "From");
    c.data.shared({ projectId: from, agentId: null }).createSchema(
      "project",
      {
        id: "p-scene",
        name: "Scene",
        description: "A scene",
        copiedFrom: null,
      },
      BEAT_V1,
    );
    const id = await newSession(c.app, from);
    seedData(c, id, [
      {
        op: "schema_put",
        id: "s-scene",
        name: "Scene",
        description: "A session scene",
        version: 1,
        body: BEAT_V2,
      },
      {
        op: "data_put",
        id: "d-1",
        schemaId: "p-scene",
        schemaVersion: 1,
        name: "Harbour",
        description: "Opening scene",
        value: { title: "Harbour" },
      },
    ]);
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Copy", description: "", systemPrompt: "", copyData: true },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Copy");
    const shared = c.data.shared({
      projectId: created?.id ?? "",
      agentId: null,
    });
    expect(shared.listSchemas("project").map((s) => s.name)).toEqual([
      "Scene",
      "Scene (2)",
    ]);
    const [harbour] = shared.listData("project");
    const used = shared.getSchema(harbour?.schemaId ?? "");
    // The data follows its schema into the new project, not the old one.
    expect(used).toMatchObject({
      scope: "project",
      name: expect.stringMatching(/^Scene/),
    });
    expect(used?.id).not.toBe("p-scene");
    expect(shared.getSchema("p-scene")).toBeUndefined();
  });

  it("leaves out data whose schema is not available, and says so", async () => {
    const c = await setup({ data: true });
    const id = await newSession(c.app);
    seedData(c, id, [
      {
        op: "data_put",
        id: "d-lost",
        schemaId: "gone",
        schemaVersion: 1,
        name: "Lost",
        description: "Its schema is out of reach",
        value: {},
      },
      {
        op: "data_put",
        id: "d-todo",
        schemaId: "builtin-task",
        schemaVersion: 1,
        name: "Draft",
        description: "Write it",
        value: { task: "Write" },
      },
    ]);
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Ashfall", description: "", systemPrompt: "", copyData: true },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    const shared = c.data.shared({
      projectId: created?.id ?? "",
      agentId: null,
    });
    expect(shared.listData("project").map((d) => d.name)).toEqual(["Draft"]);
    expect(results(c, id)[0]?.data).toMatchObject({
      schemasCopied: 0,
      dataCopied: 1,
      dataSkipped: [
        { name: "Lost", because: "its schema is not available here" },
      ],
    });
  });

  it("copies the agent as a startable project agent and tells the Dispatcher to use it", async () => {
    const c = await setup({ dispatcher: true });
    const editor = c.agents.create(null, {
      ...agentContent("Editor"),
      toolApproval: { web_search: false },
      childReminders: 3,
      childPrompt: "Hand back when done.",
      subagent: false,
    });
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push([call("a", "project_create", { name: "Ashfall" })], done);

    const { shown } = await go(c, id, {
      forms: [
        {
          name: "Ashfall",
          description: "A story",
          systemPrompt: "Be brief.",
          copyAgent: true,
        },
      ],
    });

    expect(shown[0]?.description).toBe("This session stays where it is.");
    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    const [copy] = c.agents.list(created?.id ?? "");
    expect(copy).toMatchObject({
      name: "Editor",
      description: "Editor agent",
      prompt: "You are Editor.",
      toolApproval: { web_search: false },
      childReminders: 3,
      childPrompt: "Hand back when done.",
      // The Dispatcher can only start agents marked as subagents.
      subagent: true,
      projectId: created?.id,
    });
    expect(copy?.toolGrant).toEqual(editor.toolGrant);
    // The original is left alone.
    expect(c.agents.get(editor.id)).toMatchObject({
      subagent: false,
      projectId: null,
    });

    // The prompt keeps what the user wrote, then names the agent.
    const prompt = created?.system_prompt ?? "";
    expect(
      prompt.startsWith("Be brief.\n\n## Who does the work in this project"),
    ).toBe(true);
    expect(prompt).toContain('project agent "Editor"');
    expect(prompt).toContain("start_subagent");
    // No global default, so the Dispatcher is what a new session starts with
    // anyway: the project's default is left unset.
    expect(created?.default_agent_id).toBeNull();
    expect(results(c, id)[0]?.data).toMatchObject({
      project: { id: created?.id, name: "Ashfall" },
      agent: { id: copy?.id, name: "Editor" },
    });
    expect(c.seen).toContainEqual({
      type: "agents.changed",
      data: { agentId: copy?.id, projectId: created?.id, clearedSessions: [] },
    });
  });

  it("makes the Dispatcher the project's starting agent when a global default would win", async () => {
    const c = await setup({ dispatcher: true });
    const planner = c.agents.create(null, agentContent("Planner"));
    writeSettings(c.t.db, { defaultAgentId: planner.id });
    const editor = c.agents.create(null, agentContent("Editor"));
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Ashfall", description: "", systemPrompt: "", copyAgent: true },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    expect(created?.default_agent_id).toBe(BUILTIN_DISPATCHER);
    expect(created?.system_prompt.startsWith("## Who does the work")).toBe(
      true,
    );
    expect(JSON.stringify(results(c, id)[0]?.data)).toContain(
      "new sessions in the project start with the Dispatcher",
    );
    // A session created in the project now starts with the Dispatcher.
    const inside = await newSession(c.app, created?.id);
    expect(c.store.getSession(inside)?.agent_id).toBe(BUILTIN_DISPATCHER);
  });

  it("copies the agent's own skills, schemas and data with it", async () => {
    const c = await setup({ data: true });
    const from = await newProject(c.app, "From");
    const editor = c.agents.create(from, agentContent("Editor"));
    c.skills.create(
      { scope: "agent", id: editor.id },
      { name: "tighten-prose", description: "Cut it", body: "Cut." },
    );
    c.data.shared({ projectId: from, agentId: null }).createSchema(
      "project",
      {
        id: "p-scene",
        name: "Scene",
        description: "A scene",
        copiedFrom: null,
      },
      BEAT_V1,
    );
    const own = c.data.shared({ projectId: from, agentId: editor.id });
    own.createSchema(
      "agent",
      { id: "a-beat", name: "Beat", description: "A beat", copiedFrom: null },
      BEAT_V1,
    );
    own.addSchemaVersion("a-beat", BEAT_V2);
    const put = (id: string, schemaId: string, name: string, version = 1) =>
      own.putData(
        "agent",
        {
          id,
          schemaId,
          schemaVersion: version,
          name,
          description: "d",
          value: { title: name },
        },
        { by: "user" },
      );
    put("d1", "a-beat", "Opening");
    put("d2", "p-scene", "Harbour");
    put("d3", "builtin-task", "Draft");
    const id = await newSession(c.app, from);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Copy", description: "", systemPrompt: "", copyAgent: true },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Copy");
    const [copy] = c.agents.list(created?.id ?? "");
    const copied = c.skills.list({ scope: "agent", id: copy?.id ?? "" });
    expect(copied.map((k) => k.name)).toEqual(["tighten-prose"]);
    expect(
      c.skills
        .inScope(created?.id ?? "", copy?.id ?? "")
        .find((k) => k.name === "tighten-prose")?.instructions,
    ).toBe("Cut.");
    const mine = c.data.shared({
      projectId: created?.id ?? "",
      agentId: copy?.id ?? "",
    });
    const schemas = mine.listSchemas("agent");
    expect(schemas.map((x) => [x.name, x.version])).toEqual([
      ["Beat", 2],
      ["Scene", 1],
    ]);
    const beat = schemas.find((x) => x.name === "Beat");
    expect(mine.schemaBody(beat?.id ?? "", 1)).toEqual(BEAT_V1);
    expect(mine.schemaBody(beat?.id ?? "", 2)).toEqual(BEAT_V2);
    const scene = schemas.find((x) => x.name === "Scene");
    expect(
      mine.listData("agent").map((d) => [d.name, d.schemaId, d.schemaVersion]),
    ).toEqual([
      ["Draft", "builtin-task", 1],
      ["Harbour", scene?.id, 1],
      ["Opening", beat?.id, 1],
    ]);
    // The original keeps its own, and the new project got no schemas of its own.
    expect(c.skills.list({ scope: "agent", id: editor.id })).toHaveLength(1);
    expect(own.listData("agent")).toHaveLength(3);
    expect(mine.listSchemas("project")).toEqual([]);
    expect(results(c, id)[0]?.data).toMatchObject({
      agent: { name: "Editor", skills: 1, schemas: 2, data: 3 },
    });
  });

  it("leaves the agent, the prompt and the default alone when it is not ticked", async () => {
    const c = await setup({ dispatcher: true });
    const planner = c.agents.create(null, agentContent("Planner"));
    writeSettings(c.t.db, { defaultAgentId: planner.id });
    const editor = c.agents.create(null, agentContent("Editor"));
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: editor.id });
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        {
          name: "Ashfall",
          description: "",
          systemPrompt: "Be brief.",
          copyAgent: false,
        },
      ],
    });

    const created = c.store.listProjects().find((p) => p.name === "Ashfall");
    expect(c.agents.list(created?.id ?? "")).toEqual([]);
    expect(created).toMatchObject({
      system_prompt: "Be brief.",
      default_agent_id: null,
    });
    expect(results(c, id)[0]?.data).not.toHaveProperty("agent");
  });

  it("lets a new session in the project start chatting: the Dispatcher finds the copy and starts it", async () => {
    const c = await setup({ dispatcher: true });
    const editor = c.agents.create(null, {
      ...agentContent("Editor"),
      subagent: false,
    });
    const from = await newSession(c.app);
    c.store.setSessionChoices(from, { agentId: editor.id });
    c.scripts.push([call("a", "project_create")], done);
    await go(c, from, {
      forms: [
        {
          name: "Ashfall",
          description: "",
          systemPrompt: "Stories about a volcano.",
          copyAgent: true,
        },
      ],
    });
    const project = c.store.listProjects().find((p) => p.name === "Ashfall");
    const [copy] = c.agents.list(project?.id ?? "");

    // Open the project and chat: nothing to pick, the Dispatcher starts.
    const inside = await newSession(c.app, project?.id);
    expect(c.store.getSession(inside)?.agent_id).toBe(BUILTIN_DISPATCHER);
    c.scripts.push(
      [call("l", "agents_list")],
      [call("s", "start_subagent", { agentId: copy?.id, task: "Tighten it" })],
      [call("h", "subagent_handback", { output: "Tightened." })],
      done,
    );
    const before = c.model.requests.length;
    await go(c, inside);

    // The Dispatcher's system message: the project prompt, with the note
    // naming the agent, ahead of its own prompt.
    const system = (n: number) =>
      (c.model.requests[before + n] as ChatRequest).messages.find(
        (m) => m.role === "system",
      )?.content as string;
    const dispatcher = system(0);
    expect(dispatcher).toContain("Stories about a volcano.");
    expect(dispatcher).toContain('project agent "Editor"');
    expect(dispatcher.indexOf("Stories about a volcano.")).toBeLessThan(
      dispatcher.indexOf("You are the user's entry point"),
    );

    // It sees the copy first (only startable agents are listed), and can
    // start it.
    const calls = results(c, inside);
    const list = calls.find((r) => r.name === "agents_list")?.data as {
      agents: {
        name: string;
        scope: string;
        project?: string;
      }[];
    };
    expect(list.agents[0]).toEqual(
      expect.objectContaining({
        name: "Editor",
        scope: "project",
        project: "Ashfall",
      }),
    );
    expect(calls.find((r) => r.name === "start_subagent")).toMatchObject({
      isError: false,
      data: { agent: "Editor", output: "Tightened." },
    });
    // The copy ran with its own prompt (the original agent is untouched).
    expect(system(2)).toContain("You are Editor.");
    expect(c.agents.get(editor.id)?.subagent).toBe(false);
  });

  it("does not offer the agent when the session has none", async () => {
    const c = await setup({ dispatcher: true });
    const id = await newSession(c.app);
    c.store.setSessionChoices(id, { agentId: null });
    c.scripts.push([call("a", "project_create")], done);

    const { shown } = await go(c, id, { forms: [null] });
    expect(shown[0]?.fields.map((f) => f.name)).not.toContain("copyAgent");
    expect(shown[0]?.description).toBe(
      "The project has no agent. This session stays where it is.",
    );
  });
});

describe("files_copy and files_move", () => {
  it("copies within the session's scopes and keeps the original", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A")]);
    c.scripts.push(
      [
        call("a", "files_copy", {
          keys: ["a.md"],
          from: "session",
          to: "global",
        }),
      ],
      done,
    );

    const { shown } = await go(c, id, {
      forms: [{ from: "session", to: "global" }],
    });
    expect(shown[0]?.fields).toMatchObject([
      { name: "from", default: "session", options: ["session", "global"] },
      { name: "to", default: "global", options: ["session", "global"] },
    ]);
    expect(results(c, id)[0]?.data).toEqual({
      from: "session",
      to: "global",
      copied: ["a.md"],
    });
    expect(c.files.get(null, "a.md")).toMatchObject({ value: "A" });
    // The original stays: no delete was recorded in the session.
    const ops = c.store
      .listMessages(id)
      .flatMap((m) =>
        m.message.role === "tool" ? (m.message.files ?? []) : [],
      );
    expect(ops).toEqual([]);
  });

  it("copies and moves a binary file with its bytes, to a scope and to another project", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    const id = await newSession(c.app);
    const blob = putBlob(
      c.t.db,
      "image/png",
      Buffer.from("89504e470d0a1a0a", "hex"),
      "T",
    );
    seedSession(c, id, [
      {
        op: "put",
        key: "cat.png",
        value: "",
        mediaType: "image/png",
        blob,
      },
    ]);
    c.scripts.push(
      [
        call("a", "files_copy", {
          keys: ["cat.png"],
          from: "session",
          to: "global",
        }),
      ],
      [
        call("b", "files_move", {
          keys: ["cat.png"],
          from: "session",
          toProject: target,
        }),
      ],
      done,
    );
    await go(c, id, {
      forms: [
        { from: "session", to: "global" },
        { from: "session", to: `project:${target}` },
      ],
    });
    expect(c.files.get(null, "cat.png")).toMatchObject({
      media_type: "image/png",
      value: "",
      blob_hash: blob.hash,
      size: blob.size,
    });
    expect(c.files.get(target, "cat.png")).toMatchObject({
      media_type: "image/png",
      blob_hash: blob.hash,
    });
    // The move deleted the session's file.
    const state = replaySessionFiles(
      c.store.listMessages(id).map((m) => m.message),
    );
    expect(state.files.has("cat.png")).toBe(false);
  });

  it("sends to another project, skipping keys it already has", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.files.put(
      target,
      { key: "a.md", value: "old", mediaType: "text/markdown" },
      {
        by: "user",
      },
    );
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A"), file("b.md", "B")]);
    c.scripts.push(
      [
        call("a", "files_copy", {
          keys: ["a.md", "b.md"],
          from: "session",
          toProject: target,
        }),
      ],
      done,
    );

    const { shown } = await go(c, id, {
      forms: [{ from: "session", to: `project:${target}` }],
    });
    // The form warned about the key the suggested destination has.
    expect(shown[0]?.description).toContain("would be skipped: a.md");
    expect(shown[0]?.fields[1]).toMatchObject({
      default: `project:${target}`,
      labels: { [`project:${target}`]: "Another project: Target (suggested)" },
    });
    expect(results(c, id)[0]?.data).toEqual({
      from: "session",
      to: { project: "Target", id: target },
      copied: ["b.md"],
      skipped: ["a.md"],
      skippedBecause: "the destination already has a file with that name",
    });
    expect(c.files.get(target, "a.md")).toMatchObject({
      value: "old",
    });
    expect(c.files.get(target, "b.md")).toMatchObject({
      value: "B",
      media_type: "text/markdown",
    });
    // The write is recorded as the model's, in the version history.
    expect(c.files.versions(target, "b.md")[0]).toMatchObject({
      author: "model",
      session_id: id,
    });
  });

  it("moves only what was copied", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.files.put(
      target,
      { key: "a.md", value: "old", mediaType: "text/plain" },
      {
        by: "user",
      },
    );
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A"), file("b.md", "B")]);
    c.scripts.push(
      [call("a", "files_move", { keys: ["a.md", "b.md"], toProject: target })],
      done,
    );

    await go(c, id, { forms: [{ from: "session", to: `project:${target}` }] });
    expect(results(c, id)[0]?.data).toMatchObject({
      moved: ["b.md"],
      skipped: ["a.md"],
    });
    const ops = c.store
      .listMessages(id)
      .flatMap((m) =>
        m.message.role === "tool" ? (m.message.files ?? []) : [],
      );
    expect(ops).toEqual([{ op: "delete", key: "b.md" }]);
  });

  it("never sends global files to another project", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.files.put(
      null,
      { key: "g.md", value: "G", mediaType: "text/markdown" },
      {
        by: "user",
      },
    );
    const id = await newSession(c.app);
    c.scripts.push(
      [call("a", "files_copy", { keys: ["g.md"], toProject: target })],
      done,
    );

    await go(c, id, { forms: [{ from: "global", to: `project:${target}` }] });
    expect(results(c, id)[0]).toMatchObject({ isError: true });
    expect(c.files.list(target)).toEqual([]);
  });

  it("refuses a copy to the same scope", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A")]);
    c.scripts.push([call("a", "files_copy", { keys: ["a.md"] })], done);

    await go(c, id, { forms: [{ from: "session", to: "session" }] });
    expect(results(c, id)[0]).toMatchObject({ isError: true });
  });

  it("does nothing when the form is skipped or the call is denied", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A")]);
    c.scripts.push(
      [call("a", "files_copy", { keys: ["a.md"], to: "global" })],
      done,
      [call("b", "files_copy", { keys: ["a.md"], to: "global" })],
      done,
    );

    await go(c, id, { forms: [null] });
    expect(results(c, id)[0]).toMatchObject({
      isError: true,
      data: "Not copied: the user chose not to copy these files.",
    });
    await go(c, id, { decisions: ["deny"] });
    expect(results(c, id)[1]).toMatchObject({ isError: true });
    expect(c.files.list(null)).toEqual([]);
  });

  it("limits the keys named in one call by the setting, but not 'all'", async () => {
    const c = await setup();
    writeSettings(c.t.db, { copyLimit: 2 });
    const id = await newSession(c.app);
    seedSession(c, id, [
      file("a.md", "A"),
      file("b.md", "B"),
      file("c.md", "C"),
    ]);
    c.scripts.push(
      [
        call("a", "files_copy", {
          keys: ["a.md", "b.md", "c.md"],
          to: "global",
        }),
      ],
      [call("b", "files_copy", { all: true, from: "session", to: "global" })],
      done,
    );

    await go(c, id, { forms: [{ from: "session", to: "global" }] });
    const [tooMany, all] = results(c, id);
    expect(tooMany).toMatchObject({ isError: true });
    expect(JSON.stringify(tooMany?.data)).toContain("At most 2");
    expect(all?.data).toMatchObject({ copied: ["a.md", "b.md", "c.md"] });
    expect(c.files.list(null)).toHaveLength(3);
  });

  it("needs either names or all, and a real destination project", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("a.md", "A")]);
    c.scripts.push(
      [call("a", "files_copy", { keys: ["a.md"], all: true })],
      [call("b", "files_copy", {})],
      [call("c", "files_copy", { keys: ["a.md"], toProject: "nope" })],
      done,
    );

    await go(c, id);
    const found = results(c, id);
    expect(found).toHaveLength(3);
    for (const r of found) expect(r.isError).toBe(true);
    expect(found[2]?.data).toMatchObject({
      error: expect.stringContaining("projects_list") as unknown,
    });
  });
});
