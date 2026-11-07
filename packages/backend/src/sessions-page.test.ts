import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, type ScriptStep } from "@harness/core";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";

/* The Sessions page's routes (Sessions page plan, section 2.1). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let tick = 0;
  // Increasing times, so sessions are created in a known order.
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const agents = new AgentStore(t.db, now);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [],
    agents,
    systemPrompt: () => "BASE",
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
  return { t, store, agents, runs, app };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
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

async function newSession(app: FastifyInstance, projectId?: string) {
  const { body } = await api(app, "POST", "/api/sessions", {
    ...(projectId ? { projectId } : {}),
  });
  return body.id as string;
}

async function newProject(app: FastifyInstance) {
  const { body } = await api(app, "POST", "/api/projects", { name: "P" });
  return body.id as string;
}

interface Item {
  id: string;
  running: boolean;
  agents: { id: string; name: string }[];
  usage: unknown;
}

async function page(app: FastifyInstance, query = "") {
  const res = await api(app, "GET", `/api/sessions-page${query}`);
  return {
    status: res.status,
    items: (res.body?.items ?? []) as Item[],
    total: res.body?.total as number,
    body: res.body,
  };
}

const ids = (items: { id: string }[]) => items.map((s) => s.id);

/** A run row, as if the agent had run in the session. */
function addRun(
  store: Store,
  run: {
    id: string;
    sessionId: string;
    agentId: string | null;
    startedAt: string;
    parentRunId?: string;
  },
) {
  store.db
    .prepare(
      `INSERT INTO runs (id, session_id, kind, status, started_at, agent_id, agent_version, parent_run_id)
       VALUES (?, ?, 'chat', 'finished', ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.sessionId,
      run.startedAt,
      run.agentId,
      run.agentId === null ? null : 1,
      run.parentRunId ?? null,
    );
}

describe("GET /api/sessions-page", () => {
  it("orders by creation time, newest first unless told otherwise", async () => {
    const { app } = await setup();
    const a = await newSession(app);
    const b = await newSession(app);
    const c = await newSession(app);
    expect(ids((await page(app)).items)).toEqual([c, b, a]);
    expect(ids((await page(app, "?direction=desc")).items)).toEqual([c, b, a]);
    expect(ids((await page(app, "?direction=asc")).items)).toEqual([a, b, c]);
  });

  it("breaks ties by id in the same direction, so pages do not shift", async () => {
    const { app, store } = await setup();
    for (const id of ["a", "b", "c"]) {
      store.createSession(id, id, "2026-02-01T00:00:00.000Z", null);
    }
    expect(ids((await page(app, "?direction=desc")).items)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(ids((await page(app, "?direction=asc")).items)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("pages, and reports how many sessions there are in all", async () => {
    const { app } = await setup();
    const created: string[] = [];
    for (let i = 0; i < 12; i++) created.push(await newSession(app));
    const newest = [...created].reverse();

    const first = await page(app, "?page=1&pageSize=10");
    expect(ids(first.items)).toEqual(newest.slice(0, 10));
    expect(first.total).toBe(12);

    const second = await page(app, "?page=2&pageSize=10");
    expect(ids(second.items)).toEqual(newest.slice(10));
    expect(second.total).toBe(12);

    const beyond = await page(app, "?page=3&pageSize=10");
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(12);
  });

  it("starts on page 1 of 10 when given neither", async () => {
    const { app } = await setup();
    for (let i = 0; i < 11; i++) await newSession(app);
    const got = await page(app);
    expect(got.items).toHaveLength(10);
    expect(got.total).toBe(11);
  });

  it.each([10, 25, 50, 100])("accepts a page size of %i", async (size) => {
    const { app } = await setup();
    await newSession(app);
    expect((await page(app, `?pageSize=${size}`)).status).toBe(200);
  });

  it.each(["7", "0", "1000", "abc"])(
    "refuses a page size of %s",
    async (size) => {
      const { app } = await setup();
      expect((await page(app, `?pageSize=${size}`)).status).toBe(400);
    },
  );

  it.each(["page=0", "page=-1", "page=abc", "direction=sideways"])(
    "refuses ?%s",
    async (query) => {
      const { app } = await setup();
      expect((await page(app, `?${query}`)).status).toBe(400);
    },
  );

  it("lists a project's sessions, or the standalone ones without projectId", async () => {
    const { app } = await setup();
    const project = await newProject(app);
    const standalone = await newSession(app);
    const inProject = await newSession(app, project);

    expect(ids((await page(app)).items)).toEqual([standalone]);
    expect(ids((await page(app, `?projectId=${project}`)).items)).toEqual([
      inProject,
    ]);
    expect((await page(app, `?projectId=${project}`)).total).toBe(1);
  });

  it("leaves out sessions in the trash, and does not count them", async () => {
    const { app } = await setup();
    const keep = await newSession(app);
    const gone = await newSession(app);
    await api(app, "POST", `/api/sessions/${gone}/trash`);
    const got = await page(app);
    expect(ids(got.items)).toEqual([keep]);
    expect(got.total).toBe(1);
  });

  it("carries the session's fields and usage as the plain list does", async () => {
    const { app } = await setup();
    await newSession(app);
    const plain = (await api(app, "GET", "/api/sessions")).body as unknown as {
      id: string;
      title: string;
      created_at: string;
    }[];
    const got = (await page(app)).items as unknown as {
      id: string;
      title: string;
      created_at: string;
      usage: unknown;
    }[];
    expect(got[0]).toMatchObject({
      id: plain[0]?.id,
      title: plain[0]?.title,
      created_at: plain[0]?.created_at,
      usage: null,
    });
  });

  describe("agents", () => {
    const makeAgent = (agents: AgentStore, name: string) =>
      agents.create(null, {
        name,
        description: "",
        prompt: "Be terse.",
        toolGrant: grant("allow", []),
        toolApproval: {},
      });

    it("is empty when no agent ran", async () => {
      const { app } = await setup();
      await newSession(app);
      expect((await page(app)).items[0]?.agents).toEqual([]);
    });

    it("lists each agent that ran once, in the order each first ran", async () => {
      const { app, store, agents } = await setup();
      const s = await newSession(app);
      const zed = makeAgent(agents, "Zed");
      const amy = makeAgent(agents, "Amy");
      addRun(store, {
        id: "r1",
        sessionId: s,
        agentId: zed.id,
        startedAt: "2026-03-01T00:00:01.000Z",
      });
      addRun(store, {
        id: "r2",
        sessionId: s,
        agentId: amy.id,
        startedAt: "2026-03-01T00:00:02.000Z",
      });
      addRun(store, {
        id: "r3",
        sessionId: s,
        agentId: zed.id,
        startedAt: "2026-03-01T00:00:03.000Z",
      });
      expect((await page(app)).items[0]?.agents).toEqual([
        { id: zed.id, name: "Zed" },
        { id: amy.id, name: "Amy" },
      ]);
    });

    it("includes an agent that only ran as a subagent", async () => {
      const { app, store, agents } = await setup();
      const s = await newSession(app);
      const lead = makeAgent(agents, "Lead");
      const helper = makeAgent(agents, "Helper");
      addRun(store, {
        id: "top",
        sessionId: s,
        agentId: lead.id,
        startedAt: "2026-03-01T00:00:01.000Z",
      });
      addRun(store, {
        id: "child",
        sessionId: s,
        agentId: helper.id,
        startedAt: "2026-03-01T00:00:02.000Z",
        parentRunId: "top",
      });
      expect((await page(app)).items[0]?.agents.map((a) => a.name)).toEqual([
        "Lead",
        "Helper",
      ]);
    });

    it("skips runs without an agent, and keeps sessions apart", async () => {
      const { app, store, agents } = await setup();
      const one = await newSession(app);
      const two = await newSession(app);
      const a = makeAgent(agents, "A");
      addRun(store, {
        id: "r1",
        sessionId: one,
        agentId: null,
        startedAt: "2026-03-01T00:00:01.000Z",
      });
      addRun(store, {
        id: "r2",
        sessionId: two,
        agentId: a.id,
        startedAt: "2026-03-01T00:00:02.000Z",
      });
      const got = (await page(app)).items;
      expect(got.find((s) => s.id === one)?.agents).toEqual([]);
      expect(got.find((s) => s.id === two)?.agents).toEqual([
        { id: a.id, name: "A" },
      ]);
    });

    it("still lists an agent that was deleted", async () => {
      const { app, store, agents } = await setup();
      const s = await newSession(app);
      const gone = makeAgent(agents, "Gone");
      addRun(store, {
        id: "r1",
        sessionId: s,
        agentId: gone.id,
        startedAt: "2026-03-01T00:00:01.000Z",
      });
      agents.delete(gone.id);
      expect((await page(app)).items[0]?.agents).toEqual([
        { id: gone.id, name: "Gone" },
      ]);
    });

    it("shows the agent's current name", async () => {
      const { app, store, agents } = await setup();
      const s = await newSession(app);
      const agent = makeAgent(agents, "Before");
      addRun(store, {
        id: "r1",
        sessionId: s,
        agentId: agent.id,
        startedAt: "2026-03-01T00:00:01.000Z",
      });
      agents.update(agent.id, {
        name: "After",
        description: "",
        prompt: "Be terse.",
        toolGrant: grant("allow", []),
        toolApproval: {},
      });
      expect((await page(app)).items[0]?.agents).toEqual([
        { id: agent.id, name: "After" },
      ]);
    });
  });

  it("flags a session with a run in progress as running", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const busy = await newSession(app);
    const idle = await newSession(app);
    const run = await api(app, "POST", `/api/sessions/${busy}/messages`, {
      content: "Hi",
    });
    const before = (await page(app)).items;
    expect(before.find((s) => s.id === busy)?.running).toBe(true);
    expect(before.find((s) => s.id === idle)?.running).toBe(false);

    await api(app, "POST", `/api/runs/${run.body.runId as string}/cancel`);
    await expect
      .poll(() => runs.isActive(run.body.runId as string))
      .toBe(false);
    expect((await page(app)).items.find((s) => s.id === busy)?.running).toBe(
      false,
    );
  });

  it("leaves the plain list and its shape as they were", async () => {
    const { app } = await setup();
    const s = await newSession(app);
    const res = await api(app, "GET", "/api/sessions");
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown as { id: string }[]).map((r) => r.id)).toEqual([
      s,
    ]);
    expect(res.body[0]).not.toHaveProperty("running");
    expect(res.body[0]).not.toHaveProperty("agents");
  });
});

describe("GET /api/sessions-page/ids", () => {
  it("lists every session of the project with whether it is running", async () => {
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const project = await newProject(app);
    const busy = await newSession(app, project);
    const idle = await newSession(app, project);
    await newSession(app); // standalone: not in the project
    const trashed = await newSession(app, project);
    await api(app, "POST", `/api/sessions/${trashed}/trash`);
    const run = await api(app, "POST", `/api/sessions/${busy}/messages`, {
      content: "Hi",
    });

    const res = await api(
      app,
      "GET",
      `/api/sessions-page/ids?projectId=${project}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      { id: idle, running: false },
      { id: busy, running: true },
    ]);

    await api(app, "POST", `/api/runs/${run.body.runId as string}/cancel`);
    await expect
      .poll(() => runs.isActive(run.body.runId as string))
      .toBe(false);
  });

  it("lists the standalone sessions without projectId", async () => {
    const { app } = await setup();
    const project = await newProject(app);
    await newSession(app, project);
    const standalone = await newSession(app);
    const res = await api(app, "GET", "/api/sessions-page/ids");
    expect(res.body.sessions).toEqual([{ id: standalone, running: false }]);
  });

  it("covers more sessions than one page holds", async () => {
    const { app } = await setup();
    for (let i = 0; i < 120; i++) await newSession(app);
    const res = await api(app, "GET", "/api/sessions-page/ids");
    expect(res.body.sessions as unknown[]).toHaveLength(120);
  });
});

describe("POST /api/sessions/trash", () => {
  const trashedAt = (store: Store, id: string) =>
    store.getSession(id)?.trashed_at ?? null;

  it("moves several sessions to the trash", async () => {
    const { app, store } = await setup();
    const a = await newSession(app);
    const b = await newSession(app);
    const keep = await newSession(app);
    const res = await api(app, "POST", "/api/sessions/trash", {
      ids: [a, b],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trashed: [a, b], refused: [] });
    expect(trashedAt(store, a)).not.toBeNull();
    expect(trashedAt(store, b)).not.toBeNull();
    expect(trashedAt(store, keep)).toBeNull();
    expect(ids((await page(app)).items)).toEqual([keep]);
  });

  it("emits a stored session.trashed event for each session moved", async () => {
    const { app, store } = await setup();
    const a = await newSession(app);
    const b = await newSession(app);
    await api(app, "POST", "/api/sessions/trash", { ids: [a, b] });
    const rows = store.db
      .prepare(
        "SELECT session_id FROM events WHERE type = 'session.trashed' ORDER BY id",
      )
      .all() as { session_id: string }[];
    expect(rows.map((r) => r.session_id)).toEqual([a, b]);
  });

  it("moves the rest and says why a session was refused", async () => {
    const { app, store, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise(() => {}) },
      ],
    ]);
    const ok = await newSession(app);
    const busy = await newSession(app);
    const already = await newSession(app);
    await api(app, "POST", `/api/sessions/${already}/trash`);
    const run = await api(app, "POST", `/api/sessions/${busy}/messages`, {
      content: "Hi",
    });

    const res = await api(app, "POST", "/api/sessions/trash", {
      ids: [ok, busy, already, "missing"],
    });
    expect(res.status).toBe(200);
    expect(res.body.trashed).toEqual([ok]);
    expect(res.body.refused).toEqual([
      { id: busy, error: expect.stringContaining("run is in progress") },
      { id: already, error: expect.stringContaining("already in the trash") },
      { id: "missing", error: "Session not found." },
    ]);
    expect(trashedAt(store, ok)).not.toBeNull();
    expect(trashedAt(store, busy)).toBeNull();

    await api(app, "POST", `/api/runs/${run.body.runId as string}/cancel`);
    await expect
      .poll(() => runs.isActive(run.body.runId as string))
      .toBe(false);
  });

  it("handles an id given twice once", async () => {
    const { app } = await setup();
    const a = await newSession(app);
    const res = await api(app, "POST", "/api/sessions/trash", {
      ids: [a, a],
    });
    expect(res.body).toEqual({ trashed: [a], refused: [] });
  });

  it.each([{}, { ids: [] }, { ids: [""] }, { ids: "x" }, { ids: [1] }])(
    "refuses the body %j",
    async (body) => {
      const { app } = await setup();
      expect((await api(app, "POST", "/api/sessions/trash", body)).status).toBe(
        400,
      );
    },
  );

  it("leaves the route for one session working", async () => {
    const { app, store } = await setup();
    const a = await newSession(app);
    expect((await api(app, "POST", `/api/sessions/${a}/trash`)).status).toBe(
      200,
    );
    expect(trashedAt(store, a)).not.toBeNull();
  });

  it("restores sessions moved this way", async () => {
    const { app, store } = await setup();
    const a = await newSession(app);
    await api(app, "POST", "/api/sessions/trash", { ids: [a] });
    expect((await api(app, "POST", `/api/sessions/${a}/restore`)).status).toBe(
      200,
    );
    expect(trashedAt(store, a)).toBeNull();
  });
});
