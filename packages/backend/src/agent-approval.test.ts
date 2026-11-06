import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ScriptStep,
  type Tool,
} from "@harness/core";
import { agentFromMarkdown, agentToMarkdown } from "./agent-files.js";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";
import { toolApproval } from "./tool-settings.js";

/* Per-agent tool approval (agent tool approval design). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** Records its calls. */
function recorder(name: string, approval: "ask" | "never" | "always") {
  const calls: string[] = [];
  const tool = defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({ text: z.string() }),
    approval,
    group: "utilities",
    execute: (input) => {
      calls.push(input.text);
      return { data: { got: input.text } };
    },
  });
  return { tool, calls };
}

/** `notes` stands in for an always-on files or memory tool. */
const ALWAYS_ON = ["notes"];

function tools() {
  const safe = recorder("safe", "never");
  const risky = recorder("risky", "ask");
  const locked = recorder("locked", "always");
  const notes = recorder("notes", "never");
  return {
    list: [safe.tool, risky.tool, locked.tool, notes.tool] as Tool[],
    safe: safe.calls,
    risky: risky.calls,
    locked: locked.calls,
    notes: notes.calls,
  };
}

const content = (over: Partial<AgentInput> = {}): AgentInput => ({
  name: "Editor",
  description: "",
  prompt: "",
  toolMode: "deny",
  tools: [],
  toolApproval: {},
  ...over,
});

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel(scripts);
  const seen = tools();
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: seen.list,
    alwaysOnTools: ALWAYS_ON,
    agents,
  });
  const app = buildServer({ store, runs, agents, token: TOKEN, env: {} });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, runs, app, seen };
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
  let json: unknown;
  try {
    json = res.body === "" ? undefined : JSON.parse(res.body);
  } catch {
    // Not JSON (an export).
  }
  return {
    status: res.statusCode,
    body: json as Record<string, unknown> & Record<number, unknown>,
    text: res.body,
  };
}

const call = (name: string, text: string): ScriptStep => ({
  type: "tool_call",
  callId: `call-${name}-${text}`,
  name,
  arguments: JSON.stringify({ text }),
});
const answer: ScriptStep[] = [{ type: "text", text: "Done" }];

async function newSession(app: FastifyInstance) {
  return (await api(app, "POST", "/api/sessions", { title: "T" })).body
    .id as string;
}

async function send(app: FastifyInstance, id: string, agentId?: string) {
  const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
    content: "Hi",
    agentId: agentId ?? null,
  });
  return res.body.runId as string;
}

interface Open {
  requestId: string;
  name: string;
  agentSetting?: boolean;
  alwaysAsks?: boolean;
}
const open = async (app: FastifyInstance, id: string): Promise<Open[]> =>
  (
    (await api(app, "GET", `/api/sessions/${id}`)).body as unknown as {
      activeRun: { approvals: Open[] } | null;
    }
  ).activeRun?.approvals ?? [];

async function waitIdle(runs: RunManager, runId: string) {
  await expect.poll(() => runs.isActive(runId)).toBe(false);
}

const respond = (
  app: FastifyInstance,
  runId: string,
  requestId: string,
  choice: string,
) => api(app, "POST", `/api/runs/${runId}/approvals/${requestId}`, { choice });

/** Runs one tool call by an agent; true when it asked first. */
async function asks(over: Partial<AgentInput>, tool: string) {
  const c = await setup([[call(tool, "a")], answer]);
  const agent = c.agents.create(null, content(over));
  const id = await newSession(c.app);
  const runId = await send(c.app, id, agent.id);
  // Either it asks, or the run ends without asking.
  await expect
    .poll(
      async () => (await open(c.app, id)).length > 0 || !c.runs.isActive(runId),
    )
    .toBe(true);
  const approvals = await open(c.app, id);
  if (approvals[0]) {
    await respond(c.app, runId, approvals[0].requestId, "once");
  }
  await waitIdle(c.runs, runId);
  return { c, approvals };
}

describe("the agent's setting decides", () => {
  it("asks for a tool that does not ask, and marks the request", async () => {
    const { c, approvals } = await asks(
      { toolApproval: { safe: true } },
      "safe",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ name: "safe", agentSetting: true });
    expect(c.seen.safe).toEqual(["a"]);
  });

  it("does not ask for a tool that asks", async () => {
    const { c, approvals } = await asks(
      { toolApproval: { risky: false } },
      "risky",
    );
    expect(approvals).toEqual([]);
    expect(c.seen.risky).toEqual(["a"]);
  });

  it("follows the tool's own setting when it has none", async () => {
    const asked = await asks({}, "risky");
    expect(asked.approvals).toHaveLength(1);
    expect(asked.approvals[0]).not.toHaveProperty("agentSetting");
    const quiet = await asks({}, "safe");
    expect(quiet.approvals).toEqual([]);
  });

  it("does not change a tool that always asks", async () => {
    // Stored directly: the routes do not keep such a setting.
    const { c, approvals } = await asks(
      { toolApproval: { locked: false } },
      "locked",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ name: "locked", alwaysAsks: true });
    expect(approvals[0]).not.toHaveProperty("agentSetting");
    expect(c.seen.locked).toEqual(["a"]);
  });

  it("works for an always-on tool", async () => {
    const { c, approvals } = await asks(
      { toolApproval: { notes: true } },
      "notes",
    );
    expect(approvals).toHaveLength(1);
    expect(c.seen.notes).toEqual(["a"]);
  });

  it("overrides the global setting, which still reaches agents with no setting", async () => {
    // Globally, risky does not ask. An agent with no setting follows that.
    const quiet = await setup([[call("risky", "a")], answer]);
    await api(quiet.app, "PUT", "/api/tools/risky/approval", { ask: false });
    const without = quiet.agents.create(null, content());
    const id1 = await newSession(quiet.app);
    await waitIdle(quiet.runs, await send(quiet.app, id1, without.id));
    expect(quiet.seen.risky).toEqual(["a"]);

    // An agent with its own setting asks all the same.
    const own = await setup([[call("risky", "b")], answer]);
    await api(own.app, "PUT", "/api/tools/risky/approval", { ask: false });
    const agent = own.agents.create(
      null,
      content({ toolApproval: { risky: true } }),
    );
    const id2 = await newSession(own.app);
    const runId = await send(own.app, id2, agent.id);
    await expect.poll(async () => (await open(own.app, id2)).length).toBe(1);
    const [request] = await open(own.app, id2);
    expect(request).toMatchObject({ name: "risky", agentSetting: true });
    await respond(own.app, runId, request?.requestId ?? "", "once");
    await waitIdle(own.runs, runId);
    expect(own.seen.risky).toEqual(["b"]);
  });

  it("does not affect a session with no agent", async () => {
    const c = await setup([[call("safe", "a")], answer]);
    c.agents.create(null, content({ toolApproval: { safe: true } }));
    const id = await newSession(c.app);
    const runId = await send(c.app, id);
    await waitIdle(c.runs, runId);
    expect(c.seen.safe).toEqual(["a"]);
  });
});

describe("the choices when the agent decides", () => {
  it("refuses Always allow, and keeps the request open", async () => {
    const c = await setup([[call("safe", "a")], answer]);
    const agent = c.agents.create(
      null,
      content({ toolApproval: { safe: true } }),
    );
    const id = await newSession(c.app);
    const runId = await send(c.app, id, agent.id);
    await expect.poll(async () => (await open(c.app, id)).length).toBe(1);
    const [request] = await open(c.app, id);
    const res = await respond(c.app, runId, request?.requestId ?? "", "always");
    expect(res.status).toBe(400);
    expect(c.runs.isActive(runId)).toBe(true);
    // The global setting was not touched.
    const settings = (await api(c.app, "GET", "/api/tools"))
      .body as unknown as {
      name: string;
      ask: boolean;
    }[];
    expect(settings.find((t) => t.name === "safe")?.ask).toBe(false);
    await respond(c.app, runId, request?.requestId ?? "", "deny");
    await waitIdle(c.runs, runId);
  });

  it("honours Allow for this session", async () => {
    const c = await setup([[call("safe", "a")], [call("safe", "b")], answer]);
    const agent = c.agents.create(
      null,
      content({ toolApproval: { safe: true } }),
    );
    const id = await newSession(c.app);
    const runId = await send(c.app, id, agent.id);
    await expect.poll(async () => (await open(c.app, id)).length).toBe(1);
    const [request] = await open(c.app, id);
    const res = await respond(
      c.app,
      runId,
      request?.requestId ?? "",
      "session",
    );
    expect(res.status).toBe(200);
    await waitIdle(c.runs, runId);
    // The second call was not asked about.
    expect(c.seen.safe).toEqual(["a", "b"]);
  });
});

describe("the precedence", () => {
  const settings = (db: Parameters<typeof toolApproval>[0]) => db;
  it("is always, then the agent, then the tool's setting", async () => {
    const c = await setup();
    const [safe, risky, locked] = c.runs.tools;
    if (!safe || !risky || !locked) throw new Error("tools");
    const db = settings(c.t.db);
    const agent = { toolApproval: { safe: true, risky: false, locked: false } };
    expect(toolApproval(db, locked, agent)).toEqual({
      ask: true,
      byAgent: false,
    });
    expect(toolApproval(db, safe, agent)).toEqual({ ask: true, byAgent: true });
    expect(toolApproval(db, risky, agent)).toEqual({
      ask: false,
      byAgent: true,
    });
    expect(toolApproval(db, safe, null)).toEqual({
      ask: false,
      byAgent: false,
    });
    expect(toolApproval(db, risky, { toolApproval: {} })).toEqual({
      ask: true,
      byAgent: false,
    });
  });
});

describe("saving, versions and restore", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: "Editor",
    description: "",
    prompt: "",
    toolMode: "deny",
    tools: [],
    ...over,
  });

  it("starts with no settings, and a body without the field is accepted", async () => {
    const { app } = await setup();
    const res = await api(app, "POST", "/api/global/agents", body());
    expect(res.status).toBe(201);
    expect(res.body.toolApproval).toEqual({});
  });

  it("saves, returns and versions the settings", async () => {
    const { app } = await setup();
    const a = (
      await api(
        app,
        "POST",
        "/api/global/agents",
        body({ toolApproval: { safe: true } }),
      )
    ).body as { id: string };
    const saved = await api(
      app,
      "PUT",
      `/api/agents/${a.id}`,
      body({ toolApproval: { safe: false, risky: true } }),
    );
    expect(saved.body.toolApproval).toEqual({ safe: false, risky: true });
    const v1 = await api(app, "GET", `/api/agents/${a.id}/versions/1`);
    expect(v1.body.toolApproval).toEqual({ safe: true });
    const v2 = await api(app, "GET", `/api/agents/${a.id}/versions/2`);
    expect(v2.body.toolApproval).toEqual({ safe: false, risky: true });
    // Restoring brings the version's settings back.
    const restored = await api(app, "POST", `/api/agents/${a.id}/restore`, {
      seq: 1,
    });
    expect(restored.body.toolApproval).toEqual({ safe: true });
    expect(restored.body.version).toBe(3);
  });

  it("keeps the settings through a delete and a restore", async () => {
    const { app } = await setup();
    const a = (
      await api(
        app,
        "POST",
        "/api/global/agents",
        body({ toolApproval: { safe: true } }),
      )
    ).body as { id: string };
    await api(app, "DELETE", `/api/agents/${a.id}`);
    const back = await api(app, "POST", `/api/agents/${a.id}/restore`, {
      seq: 1,
    });
    expect(back.body.toolApproval).toEqual({ safe: true });
  });

  it("drops a tool that always asks, and keeps unknown names and always-on tools", async () => {
    const { app } = await setup();
    const res = await api(
      app,
      "POST",
      "/api/global/agents",
      body({ toolApproval: { locked: false, gone: true, notes: true } }),
    );
    expect(res.body.toolApproval).toEqual({ gone: true, notes: true });
  });

  it("refuses a setting that is not true or false", async () => {
    const { app } = await setup();
    const res = await api(
      app,
      "POST",
      "/api/global/agents",
      body({ toolApproval: { safe: "yes" } }),
    );
    expect(res.status).toBe(400);
  });

  it("gives an agent made before this a setting of none", async () => {
    const { t, agents } = await setup();
    // The column's default, as in a row that existed at the migration.
    t.db.exec(
      "INSERT INTO agents (id, name, description, prompt, tool_mode, tools, version, created_at, updated_at) VALUES ('old', 'Old', '', '', 'deny', '[]', 1, 'T', 'T')",
    );
    expect(agents.get("old")?.toolApproval).toEqual({});
  });
});

describe("the tools the editor lists", () => {
  it("lists every tool with its setting now", async () => {
    const { app } = await setup();
    await api(app, "PUT", "/api/tools/safe/approval", { ask: true });
    const res = await api(app, "GET", "/api/agent-tool-approvals");
    expect(res.body).toEqual([
      {
        name: "safe",
        description: "The safe tool.",
        alwaysOn: false,
        ask: true,
        fixed: false,
      },
      {
        name: "risky",
        description: "The risky tool.",
        alwaysOn: false,
        ask: true,
        fixed: false,
      },
      {
        name: "locked",
        description: "The locked tool.",
        alwaysOn: false,
        ask: true,
        fixed: true,
      },
      {
        name: "notes",
        description: "The notes tool.",
        alwaysOn: true,
        ask: false,
        fixed: false,
      },
    ]);
  });
});

describe("agent files", () => {
  const known = ["safe", "risky", "locked", "notes"];
  const read = (md: string) =>
    agentFromMarkdown(md, known, ALWAYS_ON, ["locked"]);

  it("writes the two lists only when they have something", () => {
    expect(agentToMarkdown(content())).not.toContain("Approval");
    const md = agentToMarkdown(
      content({ toolApproval: { safe: true, risky: false } }),
    );
    expect(md).toContain("requireApproval:");
    expect(md).toContain("skipApproval:");
    expect(
      agentToMarkdown(content({ toolApproval: { safe: true } })),
    ).not.toContain("skipApproval");
  });

  it("round-trips", () => {
    const c = content({
      toolApproval: { safe: true, risky: false, notes: true },
    });
    expect(read(agentToMarkdown(c))).toEqual({
      content: {
        ...c,
        childReminders: null,
        childPrompt: null,
        subagent: false,
      },
      warnings: [],
    });
  });

  it("round-trips the subagent settings, writing them only when set", () => {
    const c = content({ subagent: true, childReminders: 0, childPrompt: "" });
    const md = agentToMarkdown(c);
    expect(md).toContain("subagent: true");
    expect(md).toContain("childReminders: 0");
    expect(read(md).content).toMatchObject({
      subagent: true,
      childReminders: 0,
      childPrompt: "",
    });
    const plain = agentToMarkdown(content());
    expect(plain).not.toContain("subagent");
    expect(plain).not.toContain("child");
  });

  it("refuses bad subagent fields", () => {
    const file = (line: string) => `---\nname: A\n${line}\n---\n\nBody\n`;
    expect(() => read(file("subagent: yes please"))).toThrow(/subagent/);
    expect(() => read(file("childReminders: -1"))).toThrow(/childReminders/);
    expect(() => read(file("childPrompt: 3"))).toThrow(/childPrompt/);
  });

  it("drops unknown tools and tools that always ask, with a warning", () => {
    const parsed = read(
      [
        "---",
        "name: A",
        "requireApproval: [safe, gone, locked]",
        "skipApproval: risky",
        "---",
        "P",
      ].join("\n"),
    );
    expect(parsed.content.toolApproval).toEqual({ safe: true, risky: false });
    expect(parsed.warnings).toEqual([
      "Dropped approval setting for tool this harness does not have: gone.",
      "Dropped approval setting for tool that always ask: locked.",
    ]);
  });

  it("refuses a tool in both lists, and a list that is not names", () => {
    expect(() =>
      read(
        "---\nname: A\nrequireApproval: [safe]\nskipApproval: [safe]\n---\nP",
      ),
    ).toThrow(/both name safe/);
    expect(() => read("---\nname: A\nrequireApproval: 3\n---\nP")).toThrow(
      /requireApproval/,
    );
  });

  it("gives no settings for a file without the lists", () => {
    expect(read("---\nname: A\n---\nP").content.toolApproval).toEqual({});
  });

  it("imports and exports through the routes", async () => {
    const { app } = await setup();
    const md = [
      "---",
      "name: Imp",
      "requireApproval: [safe]",
      "skipApproval: [risky, locked]",
      "---",
      "P",
    ].join("\n");
    const res = await api(app, "POST", "/api/global/agents/import", {
      markdown: md,
    });
    expect(res.status).toBe(201);
    const imported = res.body as unknown as {
      agent: { id: string; toolApproval: unknown };
      warnings: string[];
    };
    expect(imported.agent.toolApproval).toEqual({ safe: true, risky: false });
    expect(imported.warnings).toHaveLength(1);
    const out = await api(
      app,
      "GET",
      `/api/agents/${imported.agent.id}/export`,
    );
    expect(out.text).toContain("requireApproval:");
    expect(out.text).not.toContain("locked");
  });
});
