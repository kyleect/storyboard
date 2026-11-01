import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type StoredEvent,
  type Tool,
} from "@harness/core";
import { agentFromMarkdown, agentToMarkdown } from "./agent-files.js";
import { AgentStore, type AgentContent } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const tool = (name: string): Tool =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    approval: "never",
    execute: () => ({ data: { ran: name } }),
  });

/** `files_read` stands in for the always-on files and memory tools. */
const TOOLS = [tool("alpha"), tool("beta"), tool("gamma"), tool("files_read")];
const ALWAYS_ON = ["files_read"];

const content = (over: Partial<AgentContent> = {}): AgentContent => ({
  name: "Editor",
  description: "",
  prompt: "Be terse.",
  toolMode: "allow",
  tools: [],
  ...over,
});

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  const store = new Store(t.db);
  let tick = 0;
  // Increasing times, so versions and events order predictably.
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const agents = new AgentStore(t.db, now);
  const events = new AppEvents();
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => readSettings(t.db, {}).effective,
    model: () => model,
    tools: TOOLS,
    alwaysOnTools: ALWAYS_ON,
    agents,
    systemPrompt: () => "BASE",
    now,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    events,
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, events, runs, app, model };
}

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
  const text = res.body;
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Not JSON (an export); `text` has it.
  }
  return {
    status: res.statusCode,
    body: json as Record<string, unknown> & Record<number, unknown>,
    text,
    headers: res.headers,
  };
}

async function newSession(app: FastifyInstance, projectId?: string) {
  const { body } = await api(app, "POST", "/api/sessions", {
    ...(projectId ? { projectId } : {}),
  });
  return body.id as string;
}

async function newProject(app: FastifyInstance, name = "P") {
  const { body } = await api(app, "POST", "/api/projects", { name });
  return body.id as string;
}

async function newAgent(
  app: FastifyInstance,
  over: Partial<AgentContent> = {},
  projectId?: string,
) {
  const base = projectId
    ? `/api/projects/${projectId}/agents`
    : "/api/global/agents";
  const res = await api(app, "POST", base, content(over));
  expect(res.status).toBe(201);
  return res.body as unknown as { id: string; version: number };
}

async function waitIdle(runs: RunManager, runId: string) {
  await expect.poll(() => runs.isActive(runId)).toBe(false);
}

const answer: ScriptStep[] = [{ type: "text", text: "Done" }];
const systemOf = (r: unknown) =>
  (r as ChatRequest).messages.find((m) => m.role === "system")?.content;
const toolNames = (r: unknown) =>
  ((r as ChatRequest).tools ?? []).map((t) => t.name).sort();

describe("agent store", () => {
  it("creates and saves versions; names are trimmed", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const agents = new AgentStore(t.db);
    const a = agents.create(
      null,
      content({ name: "  Editor ", tools: ["x", "x"] }),
    );
    expect(a).toMatchObject({
      name: "Editor",
      projectId: null,
      version: 1,
      deleted: false,
      tools: ["x"],
    });
    const b = agents.update(a.id, content({ name: "Reviser", prompt: "P2" }));
    expect(b).toMatchObject({ name: "Reviser", prompt: "P2", version: 2 });
    expect(
      agents.versions(a.id).map((v) => [v.seq, v.name, v.deleted]),
    ).toEqual([
      [1, "Editor", false],
      [2, "Reviser", false],
    ]);
    expect(() => agents.update(a.id, content({ name: "  " }))).toThrow(
      /name is empty/,
    );
  });

  it("keeps names unique per scope, case-sensitive, including deleted agents", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const store = new Store(t.db);
    const agents = new AgentStore(t.db);
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const a = agents.create(null, content());
    expect(() => agents.create(null, content())).toThrow(/already exists/);
    expect(() =>
      agents.create(null, content({ name: "editor" })),
    ).not.toThrow();
    // The same name in a project is fine (both are shown, labelled).
    expect(() => agents.create("p", content())).not.toThrow();
    agents.delete(a.id);
    expect(() => agents.create(null, content())).toThrow(/deleted agent/);
  });

  it("deletes as a version, clears picks, and restores", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const store = new Store(t.db);
    const agents = new AgentStore(t.db);
    const a = agents.create(null, content());
    agents.update(a.id, content({ prompt: "Two" }));
    store.createSession("s1", "S", "T");
    store.createSession("s2", "S", "T");
    store.setSessionChoices("s1", { agentId: a.id });

    const { agent, sessions } = agents.delete(a.id);
    expect(agent).toMatchObject({ deleted: true, version: 3, prompt: "Two" });
    expect(sessions).toEqual(["s1"]);
    expect(store.getSession("s1")?.agent_id).toBeNull();
    expect(agents.versions(a.id).at(-1)).toMatchObject({
      seq: 3,
      deleted: true,
      prompt: "Two",
    });
    expect(() => agents.update(a.id, content())).toThrow(/deleted/);
    expect(() => agents.delete(a.id)).toThrow(/already deleted/);
    expect(() => agents.restore(a.id, 3)).toThrow(/deletion/);

    const back = agents.restore(a.id, 1);
    expect(back).toMatchObject({
      deleted: false,
      version: 4,
      prompt: "Be terse.",
    });
    // Restoring does not re-pick it (decision 23).
    expect(store.getSession("s1")?.agent_id).toBeNull();
    expect(() => agents.restore(a.id, 9)).toThrow(/No version 9/);
  });

  it("refuses to restore a version whose name another agent now has", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const agents = new AgentStore(t.db);
    const a = agents.create(null, content({ name: "A" }));
    agents.update(a.id, content({ name: "B" }));
    agents.create(null, content({ name: "A" }));
    expect(() => agents.restore(a.id, 1)).toThrow(/already exists/);
  });

  it("is removed when its project is purged", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const store = new Store(t.db);
    const agents = new AgentStore(t.db);
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const a = agents.create("p", content());
    const g = agents.create(null, content());
    store.createSession("s", "S", "T", "p");
    store.setSessionChoices("s", { agentId: a.id });
    store.trashProject("p", "T");
    expect(agents.get(a.id)).toBeDefined();
    store.purgeProject("p");
    expect(agents.get(a.id)).toBeUndefined();
    expect(agents.versions(a.id)).toEqual([]);
    expect(agents.get(g.id)).toBeDefined();
  });
});

describe("agent files", () => {
  it("round-trips an allow list and a deny list", () => {
    for (const toolMode of ["allow", "deny"] as const) {
      const c = content({
        description: "Tightens: prose",
        prompt: "Line one\n\nLine two",
        toolMode,
        tools: ["alpha"],
      });
      const md = agentToMarkdown(c);
      expect(md).toContain(
        toolMode === "allow" ? "tools:" : "disallowedTools:",
      );
      expect(agentFromMarkdown(md, ["alpha"], [])).toEqual({
        content: c,
        warnings: [],
      });
    }
  });

  it("reads Claude Code style files", () => {
    const md = [
      "---",
      "name: code-reviewer",
      "description: Reviews code",
      "tools: alpha, Read, files_read",
      "model: sonnet",
      "---",
      "",
      "You review code.",
      "",
    ].join("\r\n");
    expect(
      agentFromMarkdown(md, ["alpha", "files_read"], ["files_read"]),
    ).toEqual({
      content: {
        name: "code-reviewer",
        description: "Reviews code",
        prompt: "You review code.",
        toolMode: "allow",
        tools: ["alpha"],
      },
      // The always-on tool is dropped silently; the unknown one is named.
      warnings: ["Dropped tool this harness does not have: Read."],
    });
  });

  it("treats a file with no tool list as every tool on", () => {
    expect(
      agentFromMarkdown("---\nname: A\n---\nP", ["alpha"], []).content,
    ).toEqual({
      name: "A",
      description: "",
      prompt: "P",
      toolMode: "deny",
      tools: [],
    });
  });

  it("refuses files it cannot read", () => {
    const read = (md: string) => () => agentFromMarkdown(md, [], []);
    expect(read("name: A\n")).toThrow(/no front matter/);
    expect(read("---\nname: [\n---\n")).toThrow(/not valid YAML/);
    expect(read("---\n- a\n---\n")).toThrow(/set of fields/);
    expect(read("---\ndescription: x\n---\n")).toThrow(/needs a "name"/);
    expect(read("---\nname: A\ndescription: 3\n---\n")).toThrow(/must be text/);
    expect(
      read("---\nname: A\ntools: [a]\ndisallowedTools: [b]\n---\n"),
    ).toThrow(/one or the other/);
    expect(read("---\nname: A\ntools: 3\n---\n")).toThrow(/list of tool names/);
    // The closing --- must be on its own line.
    expect(read("---\nname: a---\n")).toThrow(/no front matter/);
  });
});

describe("agent routes", () => {
  it("creates, lists, saves, deletes and restores", async () => {
    const { app } = await setup();
    const res = await api(app, "POST", "/api/global/agents", {
      ...content(),
      tools: ["alpha", "files_read"],
    });
    expect(res.status).toBe(201);
    // The always-on tools are not part of a selection.
    expect(res.body).toMatchObject({
      name: "Editor",
      tools: ["alpha"],
      version: 1,
    });
    const id = res.body.id as string;

    expect((await api(app, "GET", "/api/global/agents")).body).toEqual([
      expect.objectContaining({ id, name: "Editor" }),
    ]);
    expect(
      (await api(app, "POST", "/api/global/agents", content())).status,
    ).toBe(409);

    const saved = await api(
      app,
      "PUT",
      `/api/agents/${id}`,
      content({ prompt: "P2" }),
    );
    expect(saved.body).toMatchObject({ version: 2, prompt: "P2" });
    expect((saved.body.versions as unknown[]).length).toBe(2);

    expect((await api(app, "DELETE", `/api/agents/${id}`)).status).toBe(204);
    expect((await api(app, "GET", "/api/global/agents")).body).toEqual([]);
    expect(
      (await api(app, "GET", "/api/global/agents?deleted=true")).body,
    ).toEqual([expect.objectContaining({ id, deleted: true })]);

    const restored = await api(app, "POST", `/api/agents/${id}/restore`, {
      seq: 1,
    });
    expect(restored.body).toMatchObject({
      version: 4,
      prompt: "Be terse.",
      deleted: false,
    });

    expect(
      (await api(app, "GET", `/api/agents/${id}/versions/2`)).body,
    ).toMatchObject({ agentId: id, projectId: null, seq: 2, prompt: "P2" });
    expect(
      (await api(app, "GET", `/api/agents/${id}/versions/99`)).status,
    ).toBe(404);
    expect((await api(app, "GET", "/api/agents/nope")).status).toBe(404);
  });

  it("keeps a trashed project's agents read-only", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    const a = await newAgent(app, {}, p);
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect(
      (
        await api(
          app,
          "POST",
          `/api/projects/${p}/agents`,
          content({ name: "X" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await api(app, "PUT", `/api/agents/${a.id}`, content())).status,
    ).toBe(409);
    expect((await api(app, "DELETE", `/api/agents/${a.id}`)).status).toBe(409);
    expect((await api(app, "GET", `/api/projects/${p}/agents`)).status).toBe(
      200,
    );
    expect((await api(app, "GET", "/api/projects/nope/agents")).status).toBe(
      404,
    );
  });

  it("lists the tools an agent can select", async () => {
    const { app } = await setup();
    expect((await api(app, "GET", "/api/agent-tools")).body).toEqual([
      { name: "alpha", description: "The alpha tool." },
      { name: "beta", description: "The beta tool." },
      { name: "gamma", description: "The gamma tool." },
    ]);
  });

  it("exports one agent as Markdown", async () => {
    const { app } = await setup();
    const a = await newAgent(app, { name: "Ed/itor", tools: ["beta"] });
    const res = await api(app, "GET", `/api/agents/${a.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''Ed_itor.md",
    );
    expect(agentFromMarkdown(res.text, ["beta"], []).content).toEqual(
      content({ name: "Ed/itor", tools: ["beta"] }),
    );
  });

  it("imports, asks on a name clash, and replaces as a new version", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    const md = "---\nname: Editor\ntools: [alpha, nope]\n---\n\nImported.\n";
    const first = await api(app, "POST", `/api/projects/${p}/agents/import`, {
      markdown: md,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      agent: {
        name: "Editor",
        projectId: p,
        tools: ["alpha"],
        prompt: "Imported.",
      },
      warnings: ["Dropped tool this harness does not have: nope."],
    });
    const id = (first.body.agent as { id: string }).id;

    const clash = await api(app, "POST", `/api/projects/${p}/agents/import`, {
      markdown: md,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.conflict).toEqual({ agentId: id, deleted: false });

    await api(app, "DELETE", `/api/agents/${id}`);
    const replaced = await api(
      app,
      "POST",
      `/api/projects/${p}/agents/import`,
      {
        markdown: md.replace("Imported.", "Again."),
        replace: true,
      },
    );
    expect(replaced.status).toBe(200);
    // A deleted agent is restored by a replacing import.
    expect(replaced.body.agent).toMatchObject({
      id,
      version: 3,
      prompt: "Again.",
      deleted: false,
    });
    expect(
      (await api(app, "POST", "/api/global/agents/import", { markdown: "x" }))
        .status,
    ).toBe(400);
  });
});

describe("sessions and agents", () => {
  it("offers the project's and global agents, labelled", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    const other = await newProject(app, "Q");
    const g = await newAgent(app, { name: "Editor" });
    const pa = await newAgent(app, { name: "Editor" }, p);
    await newAgent(app, { name: "Elsewhere" }, other);
    const s = await newSession(app, p);
    expect((await api(app, "GET", `/api/sessions/${s}/agents`)).body).toEqual([
      { id: pa.id, name: "Editor", description: "", scope: "project" },
      { id: g.id, name: "Editor", description: "", scope: "global" },
    ]);
    const standalone = await newSession(app);
    expect(
      (await api(app, "GET", `/api/sessions/${standalone}/agents`)).body,
    ).toEqual([{ id: g.id, name: "Editor", description: "", scope: "global" }]);
  });

  it("sets the session's agent, refusing ones it cannot use", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    const pa = await newAgent(app, { name: "P" }, p);
    const g = await newAgent(app, { name: "G" });
    const s = await newSession(app);
    const patch = (agentId: string | null) =>
      api(app, "PATCH", `/api/sessions/${s}`, { agentId });

    expect((await patch(pa.id)).status).toBe(409);
    expect((await patch("nope")).status).toBe(404);
    const ok = await patch(g.id);
    expect(ok.status).toBe(200);
    expect(ok.body.agent_id).toBe(g.id);
    expect((await patch(null)).body.agent_id).toBeNull();

    await api(app, "DELETE", `/api/agents/${g.id}`);
    expect((await patch(g.id)).status).toBe(409);
  });

  it("runs as the agent: prompt first, its tools, and records the version", async () => {
    const { app, runs, model, events } = await setup([answer, answer, answer]);
    const received: AppEvent[] = [];
    events.subscribe((e) => received.push(e));
    const a = await newAgent(app, { tools: ["alpha"] });
    const s = await newSession(app);

    // No agent: the base prompt and every tool.
    let res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, res.body.runId as string);
    expect(systemOf(model.requests[0])).toBe("BASE");
    expect(toolNames(model.requests[0])).toEqual([
      "alpha",
      "beta",
      "files_read",
      "gamma",
    ]);

    // The agent sent with the message becomes the session's.
    res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Again",
      agentId: a.id,
    });
    const runId = res.body.runId as string;
    await waitIdle(runs, runId);
    expect(systemOf(model.requests[1])).toBe("Be terse.\n\nBASE");
    expect(toolNames(model.requests[1])).toEqual(["alpha", "files_read"]);

    const detail = (await api(app, "GET", `/api/sessions/${s}`)).body as {
      session: { agent_id: string | null };
      messages: { message: { role: string }; agent: unknown }[];
    };
    expect(detail.session.agent_id).toBe(a.id);
    const assistants = detail.messages.filter(
      (m) => m.message.role === "assistant",
    );
    expect(assistants.map((m) => m.agent)).toEqual([
      null,
      { id: a.id, version: 1, name: "Editor", projectId: null },
    ]);

    // A rename makes version 2; the old message keeps the name it had.
    await api(
      app,
      "PUT",
      `/api/agents/${a.id}`,
      content({ name: "Reviser", toolMode: "deny", tools: ["beta"] }),
    );
    const after = (await api(app, "GET", `/api/sessions/${s}`)).body as {
      messages: { message: { role: string }; agent: unknown }[];
    };
    expect(
      after.messages.filter((m) => m.message.role === "assistant").at(-1)
        ?.agent,
    ).toEqual({ id: a.id, version: 1, name: "Editor", projectId: null });

    // Deleting clears the pick, and the event names the session.
    await api(app, "DELETE", `/api/agents/${a.id}`);
    expect(received.map((e) => [e.type, e.data.clearedSessions])).toEqual([
      ["agents.changed", []],
      ["agents.changed", []],
      ["agents.changed", [s]],
    ]);
  });

  it("uses a deny list and ignores tools that no longer exist", async () => {
    const { app, runs, model } = await setup([answer]);
    const a = await newAgent(app, {
      toolMode: "deny",
      tools: ["beta", "gone"],
    });
    const s = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
      agentId: a.id,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(toolNames(model.requests[0])).toEqual([
      "alpha",
      "files_read",
      "gamma",
    ]);
  });

  it("an empty allow list leaves only the always-on tools", async () => {
    const { app, runs, model } = await setup([answer]);
    const a = await newAgent(app, { toolMode: "allow", tools: [] });
    const s = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
      agentId: a.id,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(toolNames(model.requests[0])).toEqual(["files_read"]);
  });

  it("keeps the version a run started with until it ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, runs, model, store } = await setup([
      [
        { type: "wait", until: gate },
        { type: "tool_call", callId: "c1", name: "alpha", arguments: "{}" },
      ],
      answer,
      answer,
    ]);
    const a = await newAgent(app, { tools: ["alpha"] });
    const s = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
      agentId: a.id,
    });
    const runId = res.body.runId as string;
    await expect.poll(() => model.requests.length).toBe(1);

    // The snapshot shows the agent while the run is active.
    const live = (await api(app, "GET", `/api/sessions/${s}`)).body as {
      activeRun: { agent: unknown };
    };
    expect(live.activeRun.agent).toEqual({
      id: a.id,
      name: "Editor",
      version: 1,
      projectId: null,
    });

    await api(
      app,
      "PUT",
      `/api/agents/${a.id}`,
      content({ prompt: "Changed.", tools: [] }),
    );
    release();
    await waitIdle(runs, runId);
    // The second model call of the same run still uses version 1.
    expect(systemOf(model.requests[1])).toBe("Be terse.\n\nBASE");
    expect(toolNames(model.requests[1])).toEqual(["alpha", "files_read"]);
    expect(store.getRun(runId)).toMatchObject({
      agent_id: a.id,
      agent_version: 1,
    });

    const startedEvent = store
      .runEvents(runId)
      .find(
        (e): e is Extract<StoredEvent, { type: "run.started" }> =>
          e.type === "run.started",
      );
    expect(startedEvent?.data.agent).toEqual({
      id: a.id,
      name: "Editor",
      version: 1,
      projectId: null,
    });

    // The next run uses version 2.
    const next = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "More",
    });
    await waitIdle(runs, next.body.runId as string);
    expect(systemOf(model.requests[2])).toBe("Changed.\n\nBASE");
    expect(toolNames(model.requests[2])).toEqual(["files_read"]);
  });

  it("runs with no agent once the picked agent is deleted", async () => {
    const { app, runs, model } = await setup([answer, answer]);
    const a = await newAgent(app);
    const s = await newSession(app);
    await api(app, "PATCH", `/api/sessions/${s}`, { agentId: a.id });
    await api(app, "DELETE", `/api/agents/${a.id}`);
    const res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
    });
    await waitIdle(runs, res.body.runId as string);
    expect(systemOf(model.requests[0])).toBe("BASE");
  });
});

describe("app-wide events", () => {
  it("streams agents.changed to every listener, with keepalives", async () => {
    const t = tempDatabase();
    const store = new Store(t.db);
    const events = new AppEvents();
    const runs = new RunManager({
      store,
      settings: () => readSettings(t.db, {}).effective,
      model: () => new ScriptedModel([]),
      tools: TOOLS,
      alwaysOnTools: ALWAYS_ON,
    });
    const app = buildServer({
      store,
      runs,
      events,
      token: TOKEN,
      env: {},
      keepaliveMs: 30,
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(t.cleanup, () => app.close());

    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?token=${TOKEN}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(/: connected/);
    const created = await api(app, "POST", "/api/global/agents", content());
    await readUntil(/agents\.changed/);
    expect(text).toContain(
      JSON.stringify({
        type: "agents.changed",
        data: {
          agentId: created.body.id,
          projectId: null,
          clearedSessions: [],
        },
      }),
    );
    await readUntil(/: keepalive/);
    controller.abort();

    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });
});
