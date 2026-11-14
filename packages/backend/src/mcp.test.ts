import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer as SdkServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type ToolContext,
} from "@harness/core";
import { AgentStore } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { McpManager, resultText, toolName } from "./mcp-manager.js";
import {
  McpServerStore,
  type McpServer,
  type ServerInput,
} from "./mcp-store.js";
import { ProfileStore, setActiveProfile } from "./profiles.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";

/* MCP servers as a source of tools (MCP design). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const FIXTURE = fileURLToPath(
  new URL("./test-fixtures/mcp-server.mjs", import.meta.url),
);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function standardTools(s: SdkServer) {
  s.registerTool(
    "echo",
    {
      description: "Echoes the text.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text: t }) => text(`echo: ${t}`),
  );
  s.registerTool(
    "write file",
    { description: "Writes a file.", inputSchema: { path: z.string() } },
    async ({ path }) => text(`wrote ${path}`),
  );
  s.registerTool("fails", { description: "Always fails." }, async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "disk full" }],
  }));
  s.registerTool("picture", { description: "An image." }, async () => ({
    content: [
      { type: "image" as const, mimeType: "image/png", data: "AAAA" },
      { type: "text" as const, text: "caption" },
    ],
  }));
}

/** An in-process MCP server the manager connects to over a linked pair. */
class Fake {
  /** Every server made, newest last: one per connection. */
  readonly servers: SdkServer[] = [];
  constructor(private readonly register: (s: SdkServer) => void) {}

  /** The client side of a new connection to a new server. */
  transport(): Transport {
    const server = new SdkServer({ name: "fake", version: "1.0.0" });
    this.register(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // The pair queues messages until both sides have started.
    void server.connect(serverSide);
    this.servers.push(server);
    return clientSide;
  }
}

/** A transport that cannot start. */
const refusing = (): Transport => ({
  start: async () => {
    throw new Error("connection refused");
  },
  send: async () => {},
  close: async () => {},
});

type Factory = () => Transport;

async function setup(
  factories: Record<string, Factory>,
  options: { callTimeoutMs?: number } = {},
) {
  const t = tempDatabase();
  const store = new McpServerStore(t.db);
  const events = new AppEvents();
  const seen: AppEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const problems: string[] = [];
  const manager = new McpManager({
    store,
    events,
    ...options,
    createTransport: (server: McpServer) => {
      const make = factories[server.name];
      if (!make) throw new Error(`No fake for ${server.name}.`);
      return make();
    },
    onProblem: (message) => problems.push(message),
  });
  cleanups.push(() => manager.shutdown(), t.cleanup);
  return { t, store, events, seen, manager, problems };
}

const stdio = (over: Partial<ServerInput> = {}): ServerInput => ({
  name: "files",
  config: { transport: "stdio", command: "unused", args: [], env: {} },
  ...over,
});

/** Creates a server in the store and connects it. */
async function connected(c: Awaited<ReturnType<typeof setup>>, name = "files") {
  const server = c.store.create(stdio({ name }));
  c.manager.add(server);
  await c.manager.connect(server.id);
  return server;
}

const ctx = (signal = new AbortController().signal) =>
  ({ signal }) as unknown as ToolContext;

const byName = (manager: McpManager, name: string) => {
  const tool = manager.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool ${name}.`);
  return tool;
};

describe("the manager's tools", () => {
  it("offers each tool of a connected server, named by server and tool", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    const server = await connected(c);

    expect(c.manager.status(server.id)).toMatchObject({
      state: "connected",
      error: null,
    });
    expect(c.manager.tools.map((t) => t.name)).toEqual([
      "mcp_files_echo",
      "mcp_files_write_file",
      "mcp_files_fails",
      "mcp_files_picture",
    ]);
    expect(c.manager.status(server.id).tools[1]).toEqual({
      name: "mcp_files_write_file",
      serverName: "write file",
      description: "Writes a file.",
    });
  });

  it("puts the tools in the mcp group, asking by default", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    const echo = byName(c.manager, "mcp_files_echo");
    expect(echo).toMatchObject({
      group: "mcp",
      approval: "ask",
      alwaysOn: false,
      description: "Echoes the text.",
    });
    expect(echo.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(echo.inputSchema).not.toHaveProperty("$schema");
  });

  it("makes only tools not marked read-only need review", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    expect(byName(c.manager, "mcp_files_echo").needsReview).toBe(false);
    expect(byName(c.manager, "mcp_files_write_file").needsReview).toBe(true);
    // A server's hints never lower the approval.
    expect(byName(c.manager, "mcp_files_echo").approval).toBe("ask");
  });

  it("runs a call and gives the server's text", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    const out = await byName(c.manager, "mcp_files_echo").execute(
      { text: "hi" },
      ctx(),
    );
    expect(out).toEqual({ data: "echo: hi" });
  });

  it("returns a result the server marks as an error as an error result", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    const out = await byName(c.manager, "mcp_files_fails").execute({}, ctx());
    expect(out).toEqual({
      data: "disk full",
      isError: true,
      details: { server: "files", tool: "fails" },
    });
  });

  it("names what a text-only model cannot use instead of passing it on", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    const out = await byName(c.manager, "mcp_files_picture").execute({}, ctx());
    expect(out.data).toBe("[image omitted: image/png, about 3 bytes]\ncaption");
  });

  it("cuts a long result and says how much was left out", async () => {
    const fake = new Fake((s) =>
      s.registerTool("long", { description: "Long." }, async () =>
        text("x".repeat(100)),
      ),
    );
    const t = tempDatabase();
    const store = new McpServerStore(t.db);
    const manager = new McpManager({
      store,
      maxResultChars: 10,
      createTransport: () => fake.transport(),
    });
    cleanups.push(() => manager.shutdown(), t.cleanup);
    const server = store.create(stdio());
    manager.add(server);
    await manager.connect(server.id);

    const out = await byName(manager, "mcp_files_long").execute({}, ctx());
    expect(out.data).toBe(`${"x".repeat(10)}… [90 more characters]`);
  });

  it("refuses arguments that are not an object", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);

    const echo = byName(c.manager, "mcp_files_echo");
    expect(echo.parse("hi")).toEqual({
      ok: false,
      error: "The arguments must be a JSON object.",
    });
    expect(echo.parse({ text: "hi" })).toEqual({
      ok: true,
      input: { text: "hi" },
    });
  });

  it("keeps the tools of several servers apart, in server order", async () => {
    const a = new Fake(standardTools);
    const b = new Fake(standardTools);
    const c = await setup({
      zeta: () => b.transport(),
      alpha: () => a.transport(),
    });
    await connected(c, "zeta");
    await connected(c, "alpha");

    const names = c.manager.tools.map((t) => t.name);
    expect(names.slice(0, 4).every((n) => n.startsWith("mcp_alpha_"))).toBe(
      true,
    );
    expect(names.slice(4).every((n) => n.startsWith("mcp_zeta_"))).toBe(true);
  });
});

describe("connections", () => {
  it("does not connect a server that is turned off", async () => {
    let made = 0;
    const fake = new Fake(standardTools);
    const c = await setup({
      files: () => {
        made++;
        return fake.transport();
      },
    });
    const server = c.store.create(stdio({ enabled: false }));
    c.manager.add(server);
    await c.manager.connect(server.id);

    expect(made).toBe(0);
    expect(c.manager.status(server.id)).toEqual({
      state: "disabled",
      error: null,
      tools: [],
    });
    expect(c.manager.tools).toEqual([]);
  });

  it("reports a server that fails to connect, with no tools", async () => {
    const c = await setup({ files: refusing });
    const server = await connected(c);

    const status = c.manager.status(server.id);
    expect(status.state).toBe("failed");
    expect(status.error).toContain("connection refused");
    expect(c.manager.tools).toEqual([]);
    expect(c.problems).toEqual(['MCP server "files" failed to connect']);
  });

  it("announces connection changes", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    const server = await connected(c);

    expect(c.seen.length).toBeGreaterThan(0);
    expect(c.seen.every((e) => e.type === "mcp.changed")).toBe(true);
    expect(c.seen.at(-1)).toEqual({
      type: "mcp.changed",
      data: { serverId: server.id },
    });
  });

  it("follows a server's change to its tools", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    await connected(c);
    expect(c.manager.tools).toHaveLength(4);

    fake.servers[0]?.registerTool(
      "extra",
      { description: "Added later." },
      async () => text("ok"),
    );

    await expect
      .poll(() => c.manager.tools.map((t) => t.name))
      .toContain("mcp_files_extra");
  });

  it("drops the tools when the connection closes, and a call reconnects once", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    const server = await connected(c);
    // A run that started earlier still holds the tool.
    const echo = byName(c.manager, "mcp_files_echo");

    await fake.servers[0]?.close();
    await expect.poll(() => c.manager.status(server.id).state).toBe("failed");
    expect(c.manager.tools).toEqual([]);

    const out = await echo.execute({ text: "again" }, ctx());
    expect(out).toEqual({ data: "echo: again" });
    expect(fake.servers).toHaveLength(2);
    expect(c.manager.status(server.id).state).toBe("connected");
  });

  it("fails the call when the server cannot be reached again", async () => {
    let refuse = false;
    const fake = new Fake(standardTools);
    const c = await setup({
      files: () => (refuse ? refusing() : fake.transport()),
    });
    const server = await connected(c);
    const echo = byName(c.manager, "mcp_files_echo");
    refuse = true;
    await fake.servers[0]?.close();
    await expect.poll(() => c.manager.status(server.id).state).toBe("failed");

    await expect(echo.execute({ text: "x" }, ctx())).rejects.toThrow(
      /The MCP server "files" is not connected: .*connection refused/s,
    );
  });

  it("reconnects with new settings and forgets a removed server", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({ files: () => fake.transport() });
    const server = await connected(c);

    const saved = c.store.update(
      server.id,
      stdio({ enabled: false, config: server.config }),
    );
    await c.manager.replace(saved);
    expect(c.manager.status(server.id).state).toBe("disabled");
    expect(c.manager.tools).toEqual([]);

    await c.manager.replace(
      c.store.update(server.id, stdio({ config: server.config })),
    );
    expect(c.manager.status(server.id).state).toBe("connected");

    await c.manager.remove(server.id);
    expect(c.manager.tools).toEqual([]);
    expect(c.manager.status(server.id).state).toBe("disabled");
  });

  it("talks to a real stdio server", async () => {
    const t = tempDatabase();
    const store = new McpServerStore(t.db);
    const manager = new McpManager({ store });
    cleanups.push(() => manager.shutdown(), t.cleanup);
    const server = store.create({
      name: "fixture",
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: {},
      },
    });
    manager.add(server);
    await manager.connect(server.id);

    expect(manager.status(server.id).state).toBe("connected");
    const out = await byName(manager, "mcp_fixture_echo").execute(
      { text: "over stdio" },
      ctx(),
    );
    expect(out).toEqual({ data: "echo: over stdio" });
  }, 30_000);

  it("reports a stdio command that cannot be started", async () => {
    const t = tempDatabase();
    const store = new McpServerStore(t.db);
    const manager = new McpManager({ store, connectTimeoutMs: 5000 });
    cleanups.push(() => manager.shutdown(), t.cleanup);
    const server = store.create({
      name: "missing",
      config: {
        transport: "stdio",
        command: "definitely-not-a-real-command-xyz",
        args: [],
        env: {},
      },
    });
    manager.add(server);
    await manager.connect(server.id);

    expect(manager.status(server.id).state).toBe("failed");
    expect(manager.status(server.id).error).toBeTruthy();
  });
});

describe("names and results", () => {
  it("names a tool by server and tool, replacing characters a name cannot have", () => {
    const taken = new Set<string>();
    expect(toolName("files", "read.file", taken)).toBe("mcp_files_read_file");
    expect(toolName("files", "  ?? ", taken)).toBe("mcp_files_tool");
    expect(toolName("files", "naïve tool", taken)).toBe("mcp_files_na_ve_tool");
  });

  it("keeps a name within 64 characters and unique", () => {
    const taken = new Set<string>();
    const long = "a".repeat(100);
    const first = toolName("files", long, taken);
    const second = toolName("files", long, taken);
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(second).not.toBe(first);
    expect(second.endsWith("_2")).toBe(true);
    expect(toolName("files", "a", taken)).toBe("mcp_files_a");
    expect(toolName("files", "a", taken)).toBe("mcp_files_a_2");
  });

  it("turns a result's content into text", () => {
    expect(
      resultText({
        content: [
          { type: "text", text: "one" },
          {
            type: "resource",
            resource: { uri: "file:///a.txt", text: "from a resource" },
          },
          {
            type: "resource",
            resource: { uri: "file:///b.bin", blob: "AAAA" },
          },
          { type: "resource_link", uri: "file:///c", name: "c" },
        ],
      }),
    ).toBe(
      "one\nfrom a resource\n[binary resource omitted: file:///b.bin]\n[resource link: file:///c]",
    );
  });

  it("falls back to structured content when there is no text", () => {
    expect(resultText({ content: [], structuredContent: { total: 3 } })).toBe(
      '{"total":3}',
    );
    expect(resultText({ content: [] })).toBe("");
  });
});

// --- Routes ---------------------------------------------------------------

async function routes(factories: Record<string, Factory>) {
  const c = await setup(factories);
  const store = new Store(c.t.db);
  writeSettings(c.t.db, { systemPrompt: "" });
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(c.t.db, {}).effective,
      autoRename: false,
    }),
    model: () => new ScriptedModel([]),
    dynamicTools: () => c.manager.tools,
    events: c.events,
  });
  const app = buildServer({
    store,
    runs,
    token: TOKEN,
    env: {},
    mcp: { store: c.store, manager: c.manager },
  });
  cleanups.push(() => app.close());
  return { ...c, app, runs };
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
    > &
      Record<number, unknown>,
  };
}

const stdioBody = (name = "files", extra: object = {}) => ({
  name,
  config: { transport: "stdio", command: "unused" },
  ...extra,
});

describe("MCP server routes", () => {
  it("needs the token", async () => {
    const c = await routes({});
    const res = await c.app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a server, fills in defaults, and connects it", async () => {
    const fake = new Fake(standardTools);
    const c = await routes({ files: () => fake.transport() });

    const created = await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "files",
      enabled: true,
      config: { transport: "stdio", command: "unused", args: [], env: {} },
    });

    await expect
      .poll(async () => {
        const got = await api(
          c.app,
          "GET",
          `/api/mcp/servers/${created.body.id}`,
        );
        return (got.body.status as { state: string }).state;
      })
      .toBe("connected");
    const list = await api(c.app, "GET", "/api/mcp/servers");
    expect(list.body).toHaveLength(1);
    expect(c.runs.tools.map((t) => t.name)).toContain("mcp_files_echo");
  });

  it("creates an http server", async () => {
    const c = await routes({ web: refusing });
    const res = await api(c.app, "POST", "/api/mcp/servers", {
      name: "web",
      config: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.config).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  it.each([
    ["a name with capitals", stdioBody("Files")],
    ["a name that is too long", stdioBody("a".repeat(25))],
    ["a name with a space", stdioBody("my files")],
    ["no command", { name: "x", config: { transport: "stdio", command: " " } }],
    [
      "a url that is not http",
      { name: "x", config: { transport: "http", url: "ftp://example.com" } },
    ],
    ["an unknown transport", { name: "x", config: { transport: "pigeon" } }],
  ])("refuses %s", async (_label, body) => {
    const c = await routes({});
    const res = await api(c.app, "POST", "/api/mcp/servers", body);
    expect(res.status).toBe(400);
    expect(c.store.list()).toEqual([]);
  });

  it("refuses a name that is already used", async () => {
    const fake = new Fake(standardTools);
    const c = await routes({ files: () => fake.transport() });
    await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    const again = await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    expect(again.status).toBe(409);
  });

  it("saves a server and reconnects it with the new settings", async () => {
    const fake = new Fake(standardTools);
    const c = await routes({ files: () => fake.transport() });
    const created = await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    const id = created.body.id as string;
    await expect.poll(() => c.manager.status(id).state).toBe("connected");

    const saved = await api(
      c.app,
      "PUT",
      `/api/mcp/servers/${id}`,
      stdioBody("files", { enabled: false }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.enabled).toBe(false);
    await expect.poll(() => c.manager.status(id).state).toBe("disabled");
    expect(c.runs.tools).toEqual([]);
  });

  it("reconnects on request and answers when it is done", async () => {
    const fake = new Fake(standardTools);
    const c = await routes({ files: () => fake.transport() });
    const created = await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    const id = created.body.id as string;
    await expect.poll(() => c.manager.status(id).state).toBe("connected");

    const res = await api(c.app, "POST", `/api/mcp/servers/${id}/reconnect`);
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ state: "connected" });
    expect(fake.servers).toHaveLength(2);
  });

  it("will not reconnect a server that is turned off", async () => {
    const c = await routes({});
    const created = await api(
      c.app,
      "POST",
      "/api/mcp/servers",
      stdioBody("files", { enabled: false }),
    );
    const res = await api(
      c.app,
      "POST",
      `/api/mcp/servers/${created.body.id}/reconnect`,
    );
    expect(res.status).toBe(409);
  });

  it("deletes a server and takes its tools away", async () => {
    const fake = new Fake(standardTools);
    const c = await routes({ files: () => fake.transport() });
    const created = await api(c.app, "POST", "/api/mcp/servers", stdioBody());
    const id = created.body.id as string;
    await expect.poll(() => c.manager.status(id).state).toBe("connected");

    const res = await api(c.app, "DELETE", `/api/mcp/servers/${id}`);
    expect(res.status).toBe(204);
    expect(c.runs.tools).toEqual([]);
    expect((await api(c.app, "GET", `/api/mcp/servers/${id}`)).status).toBe(
      404,
    );
  });
});

// --- In a run -------------------------------------------------------------

async function runSetup(scripts: ScriptStep[][]) {
  const fake = new Fake(standardTools);
  const c = await setup({ files: () => fake.transport() });
  clearBuiltinAgents(c.t.db);
  writeSettings(c.t.db, { systemPrompt: "" });
  const store = new Store(c.t.db);
  const agents = new AgentStore(c.t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(c.t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    dynamicTools: () => c.manager.tools,
    agents,
  });
  const app = buildServer({ store, runs, agents, token: TOKEN, env: {} });
  cleanups.push(() => app.close());
  await connected(c);
  return { ...c, agents, runs, app, model };
}

const call = (name: string, args: object): ScriptStep => ({
  type: "tool_call",
  callId: `call-${name}`,
  name,
  arguments: JSON.stringify(args),
});
const done: ScriptStep[] = [{ type: "text", text: "Done" }];

describe("MCP tools in a run", () => {
  const offered = (model: ScriptedModel) =>
    ((model.requests[0] as ChatRequest).tools ?? []).map((t) => t.name);

  it("offers them to a session with no agent", async () => {
    const c = await runSetup([done]);
    const { body } = await api(c.app, "POST", "/api/sessions", {});
    const res = await api(c.app, "POST", `/api/sessions/${body.id}/messages`, {
      content: "Hi",
      agentId: null,
    });
    await expect
      .poll(() => c.runs.isActive(res.body.runId as string))
      .toBe(false);
    expect(offered(c.model)).toEqual([
      "mcp_files_echo",
      "mcp_files_write_file",
      "mcp_files_fails",
      "mcp_files_picture",
    ]);
  });

  it("gives an agent the whole group only for tools marked read-only", async () => {
    const c = await runSetup([done]);
    const agent = c.agents.create(null, {
      name: "Helper",
      description: "",
      prompt: "",
      toolGrant: { ...grant("allow", []), groups: ["mcp"] },
      toolApproval: {},
    });
    const { body } = await api(c.app, "POST", "/api/sessions", {});
    const res = await api(c.app, "POST", `/api/sessions/${body.id}/messages`, {
      content: "Hi",
      agentId: agent.id,
    });
    await expect
      .poll(() => c.runs.isActive(res.body.runId as string))
      .toBe(false);
    // write_file, fails and picture are not marked read-only.
    expect(offered(c.model)).toEqual(["mcp_files_echo"]);
  });

  it("asks before a call, runs it on approval, and gives the model the text", async () => {
    const c = await runSetup([
      [call("mcp_files_echo", { text: "hello" })],
      done,
    ]);
    const { body } = await api(c.app, "POST", "/api/sessions", {});
    const res = await api(c.app, "POST", `/api/sessions/${body.id}/messages`, {
      content: "Hi",
      agentId: null,
    });
    const runId = res.body.runId as string;

    let requestId = "";
    await expect
      .poll(async () => {
        const session = await api(c.app, "GET", `/api/sessions/${body.id}`);
        const approvals =
          (
            session.body as unknown as {
              activeRun: {
                approvals: { requestId: string; name: string }[];
              } | null;
            }
          ).activeRun?.approvals ?? [];
        requestId = approvals[0]?.requestId ?? "";
        return approvals[0]?.name;
      })
      .toBe("mcp_files_echo");
    await api(c.app, "POST", `/api/runs/${runId}/approvals/${requestId}`, {
      choice: "once",
    });
    await expect.poll(() => c.runs.isActive(runId)).toBe(false);

    const second = c.model.requests[1] as ChatRequest;
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      name: "mcp_files_echo",
      content: "echo: hello",
      isError: false,
    });
  });

  it("lists them in tool settings under the MCP group", async () => {
    const c = await runSetup([]);
    const res = await api(c.app, "GET", "/api/tools");
    const echo = (
      res.body as unknown as { name: string; group: string; ask: boolean }[]
    ).find((t) => t.name === "mcp_files_echo");
    expect(echo).toMatchObject({ group: "mcp", ask: true });
  });
});

describe("profiles", () => {
  it("reload swaps the connections for the active profile's servers", async () => {
    const fake = new Fake(standardTools);
    const c = await setup({
      files: () => fake.transport(),
      notes: () => fake.transport(),
    });
    const work = new ProfileStore(c.t.db).create("Work");
    const names = () => c.manager.tools.map((t) => t.name);

    const first = c.store.create(stdio({ name: "files" }));
    c.manager.add(first);
    await c.manager.connect(first.id);
    expect(names()).toContain("mcp_files_echo");

    // Another profile has its own servers; the first one's are dropped.
    setActiveProfile(c.t.db, work.id);
    const second = c.store.create(stdio({ name: "notes" }));
    await c.manager.reload();
    await c.manager.connect(second.id);
    expect(names()).toContain("mcp_notes_echo");
    expect(names().some((n) => n.startsWith("mcp_files_"))).toBe(false);
    expect(c.manager.status(first.id).tools).toEqual([]);

    // And back again: the first profile's server connects anew.
    setActiveProfile(c.t.db, "default");
    await c.manager.reload();
    await c.manager.connect(first.id);
    expect(names()).toContain("mcp_files_echo");
    expect(names().some((n) => n.startsWith("mcp_notes_"))).toBe(false);
  });
});
