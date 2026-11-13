import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type Tool,
  type ToolGroup,
} from "@harness/core";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";
import type { ToolGrant } from "./tool-grants.js";

/*
 * Tool management (tool management design, plan 1.2 to 1.6): groups, grants,
 * the always-on and off settings, conditions, the "new" flag, and import and
 * export by names.
 */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const tool = (
  name: string,
  group: ToolGroup,
  over: {
    alwaysOn?: boolean;
    needsReview?: boolean;
    approval?: "never" | "ask" | "always";
    available?: Tool["available"];
  } = {},
): Tool =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    approval: over.approval ?? "never",
    group,
    ...(over.alwaysOn !== undefined ? { alwaysOn: over.alwaysOn } : {}),
    ...(over.needsReview !== undefined
      ? { needsReview: over.needsReview }
      : {}),
    ...(over.available ? { available: over.available } : {}),
    execute: () => ({ data: { ran: name } }),
  });

const TOOLS = [
  tool("core_read", "files", { alwaysOn: true }),
  tool("files_edit", "files"),
  tool("files_kill", "files", { needsReview: true, approval: "always" }),
  tool("web_search", "web"),
  tool("read_webpage", "web"),
  tool("skill_add", "skills"),
  tool("needs_skill", "skills", { available: (run) => run.hasSkills }),
];
const NAMES = TOOLS.map((t) => t.name);

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: TOOLS,
    agents,
    systemPrompt: () => "BASE",
  });
  const app = buildServer({ store, runs, agents, token: TOKEN, env: {} });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, runs, app, model };
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
  let json: unknown;
  try {
    json = res.body === "" ? undefined : JSON.parse(res.body);
  } catch {
    // Not JSON (an export); `text` has it.
  }
  return {
    status: res.statusCode,
    body: json as Record<string, unknown> & Record<number, unknown>,
    text: res.body,
  };
}

const content = (over: Partial<AgentInput> = {}): AgentInput => ({
  name: "Editor",
  description: "",
  prompt: "",
  toolGrant: grant("allow", []),
  toolApproval: {},
  ...over,
});

async function newAgent(app: FastifyInstance, over: Partial<AgentInput> = {}) {
  const res = await api(app, "POST", "/api/global/agents", content(over));
  expect(res.status).toBe(201);
  return res.body as unknown as { id: string; toolGrant: ToolGrant };
}

const answer: ScriptStep[] = [{ type: "text", text: "Done" }];

/** Runs one message and gives the names of the tools the model was offered. */
async function offered(
  c: Awaited<ReturnType<typeof setup>>,
  agentId: string | null,
) {
  const { body } = await api(c.app, "POST", "/api/sessions", {});
  const res = await api(c.app, "POST", `/api/sessions/${body.id}/messages`, {
    content: "Hi",
    agentId,
  });
  await expect
    .poll(() => c.runs.isActive(res.body.runId as string))
    .toBe(false);
  const req = c.model.requests[c.model.requests.length - 1] as ChatRequest;
  return (req.tools ?? []).map((x) => x.name);
}

describe("what a run offers", () => {
  it("offers every available tool to a session with no agent", async () => {
    const c = await setup([answer]);
    // needs_skill is not available: no skill is in scope.
    expect(await offered(c, null)).toEqual(
      NAMES.filter((n) => n !== "needs_skill"),
    );
  });

  it("gives an agent a granted group, less exceptions, and the always-on tools", async () => {
    const c = await setup([answer]);
    const a = await newAgent(c.app, {
      toolGrant: {
        ...grant("allow", ["skill_add"]),
        groups: ["files"],
        except: ["files_edit"],
      },
    });
    // core_read is always on; files_edit is excepted; files_kill needs review.
    expect(await offered(c, a.id)).toEqual(["core_read", "skill_add"]);
  });

  it("covers a tool that needs review only when it is listed on its own", async () => {
    const c = await setup([answer]);
    const a = await newAgent(c.app, {
      toolGrant: { ...grant("allow", ["files_kill"]), groups: ["files"] },
    });
    expect(await offered(c, a.id)).toEqual([
      "core_read",
      "files_edit",
      "files_kill",
    ]);
  });

  it("lets a deny agent refuse a whole group", async () => {
    const c = await setup([answer]);
    const a = await newAgent(c.app, {
      toolGrant: { ...grant("deny", []), groups: ["web"] },
    });
    // files_kill needs review, so a deny agent does not have it either.
    expect(await offered(c, a.id)).toEqual([
      "core_read",
      "files_edit",
      "skill_add",
    ]);
  });

  it("gives a deny agent a tool that needs review only when it is listed in except", async () => {
    const c = await setup([answer]);
    const a = await newAgent(c.app, {
      toolGrant: {
        ...grant("deny", []),
        groups: ["web"],
        except: ["files_kill"],
      },
    });
    expect(await offered(c, a.id)).toEqual([
      "core_read",
      "files_edit",
      "files_kill",
      "skill_add",
    ]);
  });

  it("does not offer a tool that is off for the whole harness", async () => {
    const c = await setup([answer, answer, answer]);
    const res = await api(c.app, "PUT", "/api/tools/web_search/off", {
      off: true,
    });
    expect(res.body).toMatchObject({ name: "web_search", off: true });
    expect(await offered(c, null)).not.toContain("web_search");
    const a = await newAgent(c.app, {
      toolGrant: { ...grant("allow", []), groups: ["web"] },
    });
    expect(await offered(c, a.id)).toEqual(["core_read", "read_webpage"]);
    // And back on.
    await api(c.app, "PUT", "/api/tools/web_search/off", { off: false });
    expect(await offered(c, a.id)).toEqual([
      "core_read",
      "web_search",
      "read_webpage",
    ]);
  });

  it("follows the always-on setting, not the tool's default", async () => {
    const c = await setup([answer, answer]);
    const a = await newAgent(c.app, { toolGrant: grant("allow", []) });
    expect(await offered(c, a.id)).toEqual(["core_read"]);
    // Off: an agent with an empty allow list now has nothing.
    await api(c.app, "PUT", "/api/tools/core_read/always-on", {
      alwaysOn: false,
    });
    expect(await offered(c, a.id)).toEqual([]);
    // On for a tool that was not: every agent gets it.
    await api(c.app, "PUT", "/api/tools/skill_add/always-on", {
      alwaysOn: true,
    });
    expect(await offered(c, a.id)).toEqual(["skill_add"]);
  });
});

describe("tool settings routes", () => {
  it("lists the group, always-on, off and review fields, and the agents using a tool", async () => {
    const c = await setup();
    await newAgent(c.app, {
      toolGrant: { ...grant("allow", []), groups: ["web"] },
    });
    const res = await api(c.app, "GET", "/api/tools");
    const by = Object.fromEntries(
      (res.body as unknown as { name: string }[]).map((t) => [t.name, t]),
    );
    expect(by["web_search"]).toEqual({
      name: "web_search",
      description: "The web_search tool.",
      group: "web",
      askByDefault: false,
      ask: false,
      fixed: false,
      alwaysOn: false,
      alwaysOnByDefault: false,
      off: false,
      needsReview: false,
      usedByAgents: ["Editor"],
    });
    expect(by["core_read"]).toMatchObject({
      alwaysOn: true,
      alwaysOnByDefault: true,
      usedByAgents: [],
    });
    expect(by["files_kill"]).toMatchObject({ needsReview: true, fixed: true });
  });

  it("stores only a difference from the tool's default", async () => {
    const c = await setup();
    await api(c.app, "PUT", "/api/tools/core_read/always-on", {
      alwaysOn: true,
    });
    expect(
      c.t.db
        .prepare("SELECT value FROM settings WHERE key = 'toolAlwaysOn'")
        .get(),
    ).toEqual({ value: "{}" });
    await api(c.app, "PUT", "/api/tools/core_read/always-on", {
      alwaysOn: false,
    });
    expect(
      c.t.db
        .prepare("SELECT value FROM settings WHERE key = 'toolAlwaysOn'")
        .get(),
    ).toEqual({ value: '{"core_read":false}' });
  });

  it("refuses an unknown tool or group", async () => {
    const c = await setup();
    expect(
      (await api(c.app, "PUT", "/api/tools/nope/off", { off: true })).status,
    ).toBe(404);
    expect(
      (await api(c.app, "PUT", "/api/tools/nope/always-on", { alwaysOn: true }))
        .status,
    ).toBe(404);
    expect(
      (await api(c.app, "PUT", "/api/tool-groups/nope", { off: true })).status,
    ).toBe(404);
  });

  it("applies a group's settings to each of its tools, leaving a fixed approval alone", async () => {
    const c = await setup();
    const res = await api(c.app, "PUT", "/api/tool-groups/files", {
      ask: true,
      off: true,
    });
    expect(res.status).toBe(200);
    const rows = res.body as unknown as {
      name: string;
      ask: boolean;
      off: boolean;
      fixed: boolean;
    }[];
    expect(rows.map((r) => r.name)).toEqual([
      "core_read",
      "files_edit",
      "files_kill",
    ]);
    expect(rows.every((r) => r.off)).toBe(true);
    // files_kill always asks (fixed); the others now ask.
    expect(rows.map((r) => [r.name, r.ask, r.fixed])).toEqual([
      ["core_read", true, false],
      ["files_edit", true, false],
      ["files_kill", true, true],
    ]);
    // Other groups are untouched.
    const all = (await api(c.app, "GET", "/api/tools")).body as unknown as {
      name: string;
      off: boolean;
    }[];
    expect(all.find((t) => t.name === "web_search")?.off).toBe(false);
  });
});

describe("agents and the editor's tool list", () => {
  it("lists every tool with its group, always-on state and review flag", async () => {
    const c = await setup();
    await api(c.app, "PUT", "/api/tools/read_webpage/off", { off: true });
    const res = await api(c.app, "GET", "/api/agent-tools");
    expect(res.body).toEqual(
      TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        group: t.group,
        alwaysOn: t.name === "core_read",
        off: t.name === "read_webpage",
        needsReview: t.name === "files_kill",
      })),
    );
  });

  it("drops always-on tools from exceptions and extras, and records the known tools on a save", async () => {
    const c = await setup();
    const a = await newAgent(c.app, {
      toolGrant: {
        ...grant("allow", ["core_read", "web_search"]),
        except: ["core_read"],
      },
    });
    expect(a.toolGrant).toEqual({
      mode: "allow",
      groups: [],
      except: [],
      extras: ["web_search"],
      known: NAMES,
    });
  });

  it("flags tools added since the last save, until the agent is saved again", async () => {
    const c = await setup();
    // An agent saved when only two tools existed.
    const old = c.agents.create(null, {
      ...content(),
      toolGrant: grant("allow", [], ["core_read", "files_edit"]),
    });
    const got = await api(c.app, "GET", `/api/agents/${old.id}`);
    expect(got.body["newTools"]).toEqual(NAMES.slice(2));
    const list = await api(c.app, "GET", "/api/global/agents");
    expect(
      (list.body as unknown as { newTools: string[] }[])[0]?.newTools,
    ).toEqual(NAMES.slice(2));
    // Saving counts as seen (decision 10).
    const saved = await api(
      c.app,
      "PUT",
      `/api/agents/${old.id}`,
      content({ toolGrant: old.toolGrant }),
    );
    expect(saved.body["newTools"]).toEqual([]);
  });

  it("shows a deny agent only new tools that need review", async () => {
    const c = await setup();
    const old = c.agents.create(null, {
      ...content(),
      toolGrant: grant("deny", [], []),
    });
    // The other tools are on already; files_kill has to be given.
    expect(
      (await api(c.app, "GET", `/api/agents/${old.id}`)).body["newTools"],
    ).toEqual(["files_kill"]);
  });

  it("restores a version with the tools it knew, so later tools show as new", async () => {
    const c = await setup();
    const a = await newAgent(c.app);
    // An older version that knew fewer tools.
    c.t.db
      .prepare(
        `UPDATE agent_versions SET tool_grant = ? WHERE agent_id = ? AND seq = 1`,
      )
      .run(JSON.stringify(grant("allow", [], ["core_read"])), a.id);
    await api(c.app, "PUT", `/api/agents/${a.id}`, content());
    const res = await api(c.app, "POST", `/api/agents/${a.id}/restore`, {
      seq: 1,
    });
    expect(res.body["newTools"]).toEqual(NAMES.slice(1));
  });
});

describe("agent files", () => {
  it("exports the names a grant comes to, without the always-on tools", async () => {
    const c = await setup();
    const a = await newAgent(c.app, {
      toolGrant: { ...grant("allow", ["skill_add"]), groups: ["files"] },
    });
    const res = await api(c.app, "GET", `/api/agents/${a.id}/export`);
    // core_read is always on; files_kill needs review, so the group omits it.
    expect(res.text).toContain("- files_edit");
    expect(res.text).toContain("- skill_add");
    expect(res.text).not.toContain("core_read");
    expect(res.text).not.toContain("files_kill");
  });

  it("imports names as single tools, never as a group", async () => {
    const c = await setup();
    const md =
      "---\nname: Imp\ntools: [web_search, read_webpage]\n---\n\nHello.\n";
    const res = await api(c.app, "POST", "/api/global/agents/import", {
      markdown: md,
    });
    expect(res.status).toBe(201);
    expect((res.body["agent"] as { toolGrant: ToolGrant }).toolGrant).toEqual({
      mode: "allow",
      groups: [],
      except: [],
      extras: ["web_search", "read_webpage"],
      known: NAMES,
    });
  });
});
