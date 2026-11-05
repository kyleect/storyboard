import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type EntryOp,
  type Form,
  type ScriptStep,
} from "@harness/core";
import { allTools, entriesInstruction, entryTools } from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import type { AppEvent } from "./app-events.js";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

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

async function setup() {
  // Tests add scripts after creating what they refer to (ids, for example).
  const scripts: ScriptStep[][] = [];
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let clock = 0;
  const now = () => `2026-11-02T00:00:${String(++clock).padStart(2, "0")}Z`;
  const entries = new EntryStore(t.db, now);
  const agents = new AgentStore(t.db, now);
  const model = new ScriptedModel(scripts);
  let note = 0;
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    alwaysOnTools: entryTools.map((x) => x.name),
    agents,
    entries,
    systemPrompt: (s) => entriesInstruction(s.project_id !== null),
    newNoteId: () => `n${++note}`,
    now,
  });
  const seen: AppEvent[] = [];
  runs.events.subscribe((e) => seen.push(e));
  const app = buildServer({ store, runs, entries, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, entries, agents, seen, scripts };
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

/** Puts files and notes in a session's scope, as the user editing them. */
function seedSession(c: Ctx, sessionId: string, ops: EntryOp[]) {
  c.runs.editSessionEntries(sessionId, ops);
}
const file = (key: string, value: string): EntryOp => ({
  op: "put",
  kind: "file",
  key,
  type: "markdown",
  value,
});
const note = (key: string, value: string): EntryOp => ({
  op: "put",
  kind: "note",
  key,
  value,
});

const agentContent = (name: string) => ({
  name,
  description: `${name} agent`,
  prompt: `You are ${name}.`,
  toolMode: "deny" as const,
  tools: ["web_search"],
  toolApproval: {},
});

describe("agents_list and agent_view", () => {
  it("lists the agents the session can pick, with their scope", async () => {
    const c = await setup();
    const projectId = await newProject(c.app, "Ashfall");
    const other = await newProject(c.app, "Other");
    c.agents.create(projectId, { ...agentContent("Editor"), subagent: true });
    c.agents.create(null, agentContent("Critic"));
    c.agents.create(other, agentContent("Elsewhere"));
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
      tools: ["web_search"],
      subagent: true,
    });
    // Every agent is listed, with whether it can be started.
    expect(agents[1]).toMatchObject({ scope: "global", subagent: false });
    expect(agents[1]).not.toHaveProperty("project");
  });

  it("agent_view says when there is no agent", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    c.scripts.push([call("a", "agent_view")], done);
    await go(c, id);
    expect(results(c, id)[0]?.data).toEqual({
      agent: null,
      note: "This run has no agent.",
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
      note: "This session is not in a project.",
    });
  });

  it("creates a project with no agent from the session, copying what was ticked", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [file("topics.md", "Topics"), note("n0", "A note")]);
    c.scripts.push([call("a", "project_create", { name: "Research" })], done);

    const { shown } = await go(c, id, {
      forms: [
        {
          name: "Research topics",
          description: "Looking things up",
          systemPrompt: "You research.",
          copyFiles: true,
          copyNotes: false,
        },
      ],
    });

    // The form suggested the name and offered both copies, ticked.
    expect(shown[0]?.fields.map((f) => f.name)).toEqual([
      "name",
      "description",
      "systemPrompt",
      "copyFiles",
      "copyNotes",
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
      notesCopied: 0,
    });
    expect(
      c.entries.list("file", created?.id ?? "").map((e) => [e.key, e.value]),
    ).toEqual([["topics.md", "Topics"]]);
    expect(c.entries.list("note", created?.id ?? "")).toEqual([]);
    // The session stays where it is, and windows are told.
    expect(c.store.getSession(id)?.project_id).toBeNull();
    expect(c.seen).toContainEqual({
      type: "projects.changed",
      data: { projectId: created?.id },
    });
  });

  it("copies the notes too when ticked, as new notes", async () => {
    const c = await setup();
    const id = await newSession(c.app);
    seedSession(c, id, [note("n0", "Remember this")]);
    c.scripts.push([call("a", "project_create")], done);

    await go(c, id, {
      forms: [
        { name: "Notes", description: "", systemPrompt: "", copyNotes: true },
      ],
    });
    const created = c.store.listProjects().find((p) => p.name === "Notes");
    expect(
      c.entries.list("note", created?.id ?? "").map((e) => e.value),
    ).toEqual(["Remember this"]);
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
    expect(c.entries.get("file", null, "a.md")).toMatchObject({ value: "A" });
    // The original stays: no delete was recorded in the session.
    const ops = c.store
      .listMessages(id)
      .flatMap((m) =>
        m.message.role === "tool" ? (m.message.entries ?? []) : [],
      );
    expect(ops).toEqual([]);
  });

  it("sends to another project, skipping keys it already has", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.entries.put(
      "file",
      target,
      { key: "a.md", value: "old", type: "markdown" },
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
    expect(c.entries.get("file", target, "a.md")).toMatchObject({
      value: "old",
    });
    expect(c.entries.get("file", target, "b.md")).toMatchObject({
      value: "B",
      type: "markdown",
    });
    // The write is recorded as the model's, in the version history.
    expect(c.entries.versions("file", target, "b.md")[0]).toMatchObject({
      author: "model",
      session_id: id,
    });
  });

  it("moves only what was copied", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.entries.put(
      "file",
      target,
      { key: "a.md", value: "old", type: "plain" },
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
        m.message.role === "tool" ? (m.message.entries ?? []) : [],
      );
    expect(ops).toEqual([{ op: "delete", kind: "file", key: "b.md" }]);
  });

  it("never sends global entries to another project", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    c.entries.put(
      "file",
      null,
      { key: "g.md", value: "G", type: "markdown" },
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
    expect(c.entries.list("file", target)).toEqual([]);
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
    expect(c.entries.list("file", null)).toEqual([]);
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
    expect(c.entries.list("file", null)).toHaveLength(3);
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

describe("memory_copy and memory_move", () => {
  it("copies a note with a new id and keeps the original", async () => {
    const c = await setup();
    const projectId = await newProject(c.app, "Ashfall");
    const id = await newSession(c.app, projectId);
    seedSession(c, id, [note("old1", "Remember this")]);
    c.scripts.push(
      [
        call("a", "memory_copy", {
          ids: ["old1"],
          from: "session",
          to: "project",
        }),
      ],
      done,
    );

    const { shown } = await go(c, id, {
      forms: [{ from: "session", to: "project" }],
    });
    expect(shown[0]?.fields[1]).toMatchObject({
      options: ["session", "project", "global"],
      labels: { project: "project (Ashfall) (suggested)" },
    });
    expect(results(c, id)[0]?.data).toMatchObject({
      from: "session",
      to: "project",
      copied: [{ id: "old1", newId: "n1" }],
    });
    expect(
      c.entries.list("note", projectId).map((e) => [e.key, e.value]),
    ).toEqual([["n1", "Remember this"]]);
  });

  it("moves notes to another project and deletes the originals", async () => {
    const c = await setup();
    const target = await newProject(c.app, "Target");
    const id = await newSession(c.app);
    seedSession(c, id, [note("a", "One"), note("b", "Two")]);
    c.scripts.push(
      [call("a", "memory_move", { all: true, toProject: target })],
      done,
    );

    await go(c, id, { forms: [{ from: "session", to: `project:${target}` }] });
    expect(results(c, id)[0]?.data).toMatchObject({
      moved: [
        { id: "a", newId: "n1" },
        { id: "b", newId: "n2" },
      ],
    });
    expect(c.entries.list("note", target).map((e) => e.value)).toEqual([
      "One",
      "Two",
    ]);
    const ops = c.store
      .listMessages(id)
      .flatMap((m) =>
        m.message.role === "tool" ? (m.message.entries ?? []) : [],
      );
    expect(ops).toEqual([
      { op: "delete", kind: "note", key: "a" },
      { op: "delete", kind: "note", key: "b" },
    ]);
  });
});
