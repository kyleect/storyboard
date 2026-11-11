import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type Tool,
} from "@harness/core";
import { skillLoad, skillsList, SKILL_LOAD } from "@harness/tools";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS, readSettings, writeSettings } from "./settings.js";
import {
  MAX_DESCRIPTION,
  slugify,
  SkillStore,
  type SkillContent,
  type SkillOwner,
} from "./skills-store.js";
import { Store } from "./store.js";
import { grant, clearBuiltins, tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const tool = (name: string, alwaysOn = false): Tool =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    approval: "never",
    group: "utilities" as const,
    alwaysOn,
    execute: () => ({ data: { ran: name } }),
  });

/** `files_read` stands in for the always-on files and memory tools. */
const TOOLS = [tool("alpha"), tool("files_read", true), skillLoad];

const content = (over: Partial<SkillContent> = {}): SkillContent => ({
  displayName: "My Skill",
  description: "Use when testing.",
  body: "Do the thing.",
  ...over,
});

const agentContent = (over: Partial<AgentInput> = {}): AgentInput => ({
  name: "Editor",
  description: "",
  prompt: "Be terse.",
  toolGrant: grant("allow", []),
  toolApproval: {},
  ...over,
});

const GLOBAL: SkillOwner = { scope: "global" };

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  clearBuiltins(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const agents = new AgentStore(t.db, now);
  const skills = new SkillStore(t.db, now);
  const events = new AppEvents();
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
    skills,
    skillsList,
    systemPrompt: () => "BASE",
    now,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    skills,
    events,
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, skills, events, runs, app, model };
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

async function newProject(app: FastifyInstance, name = "P") {
  const { body } = await api(app, "POST", "/api/projects", { name });
  return body.id as string;
}

async function newAgent(
  app: FastifyInstance,
  over: Partial<AgentInput> = {},
  projectId?: string,
) {
  const base = projectId
    ? `/api/projects/${projectId}/agents`
    : "/api/global/agents";
  const res = await api(app, "POST", base, agentContent(over));
  expect(res.status).toBe(201);
  return res.body as unknown as { id: string };
}

async function waitIdle(runs: RunManager, runId: string) {
  await expect.poll(() => runs.isActive(runId)).toBe(false);
}

const answer: ScriptStep[] = [{ type: "text", text: "Done" }];
const systemOf = (r: unknown) =>
  (r as ChatRequest).messages.find((m) => m.role === "system")?.content;
const toolNames = (r: unknown) =>
  ((r as ChatRequest).tools ?? []).map((t) => t.name).sort();

describe("slugify (skills design, decision 4)", () => {
  it("makes lowercase names with single hyphens", () => {
    expect(slugify("My Skill")).toBe("my-skill");
    expect(slugify("  Dialogue   Polish!! ")).toBe("dialogue-polish");
    expect(slugify("A_b--c.d")).toBe("a-b-c-d");
    expect(slugify("Scene 2: Outline")).toBe("scene-2-outline");
  });

  it("transliterates accents and drops what it cannot", () => {
    expect(slugify("Café Scène")).toBe("cafe-scene");
    expect(slugify("日本語 notes")).toBe("notes");
  });

  it("is empty when no letters or digits are left", () => {
    expect(slugify("!!! ---")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("is at most 64 characters, with no hyphen at the end", () => {
    const slug = slugify(`${"a".repeat(63)} b`);
    expect(slug).toBe("a".repeat(63));
    expect(slugify("a".repeat(100))).toHaveLength(64);
  });
});

describe("skill store", () => {
  it("creates and saves versions; the name follows the display name", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const skills = new SkillStore(t.db);
    const s = skills.create(GLOBAL, content({ displayName: "  My Skill " }));
    expect(s).toMatchObject({
      displayName: "My Skill",
      name: "my-skill",
      scope: "global",
      projectId: null,
      agentId: null,
      version: 1,
      deleted: false,
    });
    const b = skills.update(
      s.id,
      content({ displayName: "Better Skill", body: "B2" }),
    );
    expect(b).toMatchObject({
      displayName: "Better Skill",
      name: "better-skill",
      body: "B2",
      version: 2,
    });
    expect(
      skills.versions(s.id).map((v) => [v.seq, v.name, v.body, v.deleted]),
    ).toEqual([
      [1, "my-skill", "Do the thing.", false],
      [2, "better-skill", "B2", false],
    ]);
  });

  it("checks the name, the description and the slug", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const skills = new SkillStore(t.db);
    expect(() => skills.create(GLOBAL, content({ displayName: "  " }))).toThrow(
      /name is empty/,
    );
    expect(() => skills.create(GLOBAL, content({ description: " " }))).toThrow(
      /description is required/,
    );
    expect(() =>
      skills.create(
        GLOBAL,
        content({ description: "x".repeat(MAX_DESCRIPTION + 1) }),
      ),
    ).toThrow(/the most is 1024/);
    expect(() =>
      skills.create(
        GLOBAL,
        content({ description: "x".repeat(MAX_DESCRIPTION) }),
      ),
    ).not.toThrow();
    expect(() =>
      skills.create(GLOBAL, content({ displayName: "!!!" })),
    ).toThrow(/no letters or digits/);
    // An empty body is allowed.
    expect(() =>
      skills.create(GLOBAL, content({ displayName: "Empty", body: "" })),
    ).not.toThrow();
  });

  it("keeps names unique per scope, including deleted skills", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const store = new Store(t.db);
    const agents = new AgentStore(t.db);
    const skills = new SkillStore(t.db);
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const agent = agents.create(null, agentContent());
    const s = skills.create(GLOBAL, content());
    // The slug is what clashes, not the display name.
    expect(() =>
      skills.create(GLOBAL, content({ displayName: "my  SKILL" })),
    ).toThrow(/already exists/);
    // The same name in another scope is fine (decision 2).
    expect(() =>
      skills.create({ scope: "project", id: "p" }, content()),
    ).not.toThrow();
    expect(() =>
      skills.create({ scope: "agent", id: agent.id }, content()),
    ).not.toThrow();
    skills.delete(s.id);
    expect(() => skills.create(GLOBAL, content())).toThrow(/deleted skill/);
    // A rename onto another skill's name is refused too.
    const other = skills.create(GLOBAL, content({ displayName: "Other" }));
    expect(() => skills.update(other.id, content())).toThrow(/deleted skill/);
  });

  it("deletes as a version and restores", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const skills = new SkillStore(t.db);
    const s = skills.create(GLOBAL, content());
    skills.update(s.id, content({ body: "V2" }));
    const gone = skills.delete(s.id);
    expect(gone).toMatchObject({ deleted: true, version: 3, body: "V2" });
    expect(skills.list(GLOBAL)).toEqual([]);
    expect(skills.list(GLOBAL, true)).toHaveLength(1);
    expect(() => skills.update(s.id, content())).toThrow(/is deleted/);
    expect(() => skills.delete(s.id)).toThrow(/already deleted/);
    expect(() => skills.restore(s.id, 3)).toThrow(/a deletion/);
    expect(() => skills.restore(s.id, 9)).toThrow(/No version 9/);
    // Restoring an earlier version makes it the next one, and undeletes.
    const back = skills.restore(s.id, 1);
    expect(back).toMatchObject({
      deleted: false,
      version: 4,
      body: "Do the thing.",
    });
    expect(skills.versions(s.id).map((v) => v.deleted)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("refuses to restore a version whose name another skill now has", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const skills = new SkillStore(t.db);
    const a = skills.create(GLOBAL, content({ displayName: "A" }));
    skills.update(a.id, content({ displayName: "B" }));
    skills.create(GLOBAL, content({ displayName: "A" }));
    expect(() => skills.restore(a.id, 1)).toThrow(/already exists/);
  });
});

describe("skills in scope (decision 1)", () => {
  it("gives each session and agent the skills the design lists", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const store = new Store(t.db);
    const agents = new AgentStore(t.db);
    const skills = new SkillStore(t.db);
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    store.createProject({ id: "q", name: "Q", description: "", now: "T" });
    const globalAgent = agents.create(null, agentContent({ name: "G" }));
    const projectAgent = agents.create("p", agentContent({ name: "PA" }));
    const otherAgent = agents.create(null, agentContent({ name: "O" }));
    const named = (displayName: string) => content({ displayName });
    skills.create(GLOBAL, named("g"));
    skills.create({ scope: "project", id: "p" }, named("p"));
    skills.create({ scope: "project", id: "q" }, named("q"));
    skills.create({ scope: "agent", id: globalAgent.id }, named("ga"));
    skills.create({ scope: "agent", id: projectAgent.id }, named("pa"));
    skills.create({ scope: "agent", id: otherAgent.id }, named("oa"));
    const names = (projectId: string | null, agentId: string | null) =>
      skills.inScope(projectId, agentId).map((s) => `${s.scope}:${s.name}`);

    // Standalone, no agent: global.
    expect(names(null, null)).toEqual(["global:g"]);
    // Standalone, a global agent: global and the agent's.
    expect(names(null, globalAgent.id)).toEqual(["global:g", "agent:ga"]);
    // Project, no agent: global and the project's.
    expect(names("p", null)).toEqual(["global:g", "project:p"]);
    // Project, a project agent: all three.
    expect(names("p", projectAgent.id)).toEqual([
      "global:g",
      "project:p",
      "agent:pa",
    ]);
    // Project, a global agent: also all three (decision 1).
    expect(names("p", globalAgent.id)).toEqual([
      "global:g",
      "project:p",
      "agent:ga",
    ]);
  });

  it("leaves out deleted skills and carries the content", () => {
    const t = tempDatabase();
    clearBuiltins(t.db);
    cleanups.push(t.cleanup);
    const skills = new SkillStore(t.db);
    const a = skills.create(GLOBAL, content({ displayName: "A" }));
    skills.create(GLOBAL, content({ displayName: "B", body: "BB" }));
    skills.delete(a.id);
    expect(skills.inScope(null, null)).toEqual([
      {
        name: "b",
        displayName: "B",
        description: "Use when testing.",
        body: "BB",
        scope: "global",
      },
    ]);
  });
});

describe("skill routes", () => {
  it("creates, lists, saves, deletes and restores in each scope", async () => {
    const { app, events } = await setup();
    const received: AppEvent[] = [];
    events.subscribe((e) => received.push(e));
    const p = await newProject(app);
    const agent = await newAgent(app);
    const bases = [
      "/api/global/skills",
      `/api/projects/${p}/skills`,
      `/api/agents/${agent.id}/skills`,
    ];
    for (const base of bases) {
      const created = await api(app, "POST", base, content());
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "my-skill", version: 1 });
      expect(created.body.versions).toHaveLength(1);
      const id = created.body.id as string;

      const list = await api(app, "GET", base);
      expect(
        (list.body as unknown as { id: string }[]).map((s) => s.id),
      ).toEqual([id]);
      // Another scope's list does not have it.
      expect(
        (await api(app, "GET", bases.find((b) => b !== base) as string)).body,
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));

      const saved = await api(
        app,
        "PUT",
        `/api/skills/${id}`,
        content({ displayName: "Renamed Skill" }),
      );
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ name: "renamed-skill", version: 2 });

      expect((await api(app, "DELETE", `/api/skills/${id}`)).status).toBe(204);
      expect((await api(app, "GET", base)).body).toEqual([]);
      expect(
        (await api(app, "GET", `${base}?deleted=true`))
          .body as unknown as unknown[],
      ).toHaveLength(1);

      const restored = await api(app, "POST", `/api/skills/${id}/restore`, {
        seq: 1,
      });
      expect(restored.body).toMatchObject({
        deleted: false,
        displayName: "My Skill",
        version: 4,
      });
    }
    expect(received.filter((e) => e.type === "skills.changed").length).toBe(
      bases.length * 4,
    );
    const first = received.find((e) => e.type === "skills.changed");
    expect(first).toMatchObject({
      data: { projectId: null, agentId: null },
    });
  });

  it("refuses bad input and name clashes", async () => {
    const { app } = await setup();
    const base = "/api/global/skills";
    expect((await api(app, "POST", base, content())).status).toBe(201);
    const clash = await api(
      app,
      "POST",
      base,
      content({ displayName: "my skill" }),
    );
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already exists/);
    expect(
      (await api(app, "POST", base, content({ description: "" }))).status,
    ).toBe(400);
    expect(
      (await api(app, "POST", base, content({ displayName: "???" }))).status,
    ).toBe(400);
    expect((await api(app, "POST", base, { displayName: "X" })).status).toBe(
      400,
    );
    expect((await api(app, "GET", "/api/skills/nope")).status).toBe(404);
    expect((await api(app, "GET", "/api/projects/nope/skills")).status).toBe(
      404,
    );
    expect((await api(app, "GET", "/api/agents/nope/skills")).status).toBe(404);
  });

  it("keeps a trashed project's skills read-only", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    const s = (await api(app, "POST", `/api/projects/${p}/skills`, content()))
      .body.id as string;
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect(
      (
        await api(
          app,
          "POST",
          `/api/projects/${p}/skills`,
          content({ displayName: "X" }),
        )
      ).status,
    ).toBe(409);
    expect((await api(app, "PUT", `/api/skills/${s}`, content())).status).toBe(
      409,
    );
    expect((await api(app, "DELETE", `/api/skills/${s}`)).status).toBe(409);
    expect((await api(app, "GET", `/api/projects/${p}/skills`)).status).toBe(
      200,
    );
  });

  it("keeps a deleted agent's skills read-only, and brings them back with it", async () => {
    const { app } = await setup();
    const agent = await newAgent(app);
    const s = (
      await api(app, "POST", `/api/agents/${agent.id}/skills`, content())
    ).body.id as string;
    await api(app, "DELETE", `/api/agents/${agent.id}`);
    expect((await api(app, "PUT", `/api/skills/${s}`, content())).status).toBe(
      409,
    );
    expect(
      (
        await api(
          app,
          "POST",
          `/api/agents/${agent.id}/skills`,
          content({ displayName: "X" }),
        )
      ).status,
    ).toBe(409);
    // The skill itself was not deleted; restoring the agent frees it again.
    await api(app, "POST", `/api/agents/${agent.id}/restore`, { seq: 1 });
    expect((await api(app, "PUT", `/api/skills/${s}`, content())).status).toBe(
      200,
    );
  });

  it("is removed when its project is purged, with the project's agents' skills", async () => {
    const { app, store, skills, agents } = await setup();
    const p = await newProject(app);
    const projectAgent = await newAgent(app, {}, p);
    const globalAgent = await newAgent(app);
    const own = skills.create({ scope: "project", id: p }, content());
    const ofAgent = skills.create(
      { scope: "agent", id: projectAgent.id },
      content(),
    );
    const ofGlobalAgent = skills.create(
      { scope: "agent", id: globalAgent.id },
      content(),
    );
    const global = skills.create(GLOBAL, content());
    store.trashProject(p, "T");
    expect(skills.get(own.id)).toBeDefined();
    store.purgeProject(p);
    for (const gone of [own, ofAgent]) {
      expect(skills.get(gone.id)).toBeUndefined();
      expect(skills.versions(gone.id)).toEqual([]);
    }
    expect(skills.get(ofGlobalAgent.id)).toBeDefined();
    expect(skills.get(global.id)).toBeDefined();
    expect(agents.get(projectAgent.id)).toBeUndefined();
  });
});

describe("skills in runs", () => {
  it("lists skills after the agent prompt and before the base, and offers the tool", async () => {
    const { app, runs, model, skills, t } = await setup([
      answer,
      answer,
      answer,
    ]);
    writeSettings(t.db, { systemPrompt: "Global." });
    const p = await newProject(app);
    await api(app, "PATCH", `/api/projects/${p}`, { systemPrompt: "Project." });
    const agent = await newAgent(app, {}, p);
    skills.create(
      GLOBAL,
      content({ displayName: "G One", description: "Global one." }),
    );
    skills.create(
      { scope: "project", id: p },
      content({ displayName: "P One", description: "Project one." }),
    );
    skills.create(
      { scope: "agent", id: agent.id },
      content({ displayName: "A One", description: "Agent one." }),
    );
    const send = async (session: string, agentId?: string) => {
      const res = await api(app, "POST", `/api/sessions/${session}/messages`, {
        content: "Hi",
        agentId: agentId ?? null,
      });
      await waitIdle(runs, res.body.runId as string);
    };

    await send(await newSession(app, p), agent.id);
    const system = systemOf(model.requests[0]) as string;
    const list = `${DEFAULTS.skillsInstruction}\n\n${skillsList(skills.inScope(p, agent.id))}`;
    expect(system).toBe(`Global.\n\nProject.\n\nBe terse.\n\n${list}\n\nBASE`);
    expect(list).toContain("- g-one: Global one.");
    expect(list).toContain("- p-one: Project one.");
    expect(list).toContain("- a-one: Agent one.");
    expect(toolNames(model.requests[0])).toContain(SKILL_LOAD);

    // A standalone session has global skills only.
    await send(await newSession(app));
    expect(systemOf(model.requests[1])).toBe(
      `Global.\n\n${DEFAULTS.skillsInstruction}\n\n${skillsList(skills.inScope(null, null))}\n\nBASE`,
    );
    expect(systemOf(model.requests[1])).not.toContain("p-one");

    // A project session with no agent: global and project.
    await send(await newSession(app, p));
    expect(systemOf(model.requests[2])).toContain("- p-one:");
    expect(systemOf(model.requests[2])).not.toContain("a-one");
  });

  it("offers the tool only when a skill is in scope, and agents cannot select it", async () => {
    const { app, runs, model, skills } = await setup([answer, answer, answer]);
    const s = await newSession(app);
    // No skills: no list, no tool.
    let res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
      agentId: null,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(systemOf(model.requests[0])).toBe("BASE");
    expect(toolNames(model.requests[0])).toEqual(["alpha", "files_read"]);

    skills.create(GLOBAL, content());
    res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Again",
      agentId: null,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(toolNames(model.requests[1])).toEqual([
      "alpha",
      "files_read",
      SKILL_LOAD,
    ]);

    // Not part of an agent's selection, but an empty allow list keeps it.
    const tools = (await api(app, "GET", "/api/agent-tools"))
      .body as unknown as {
      name: string;
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      "alpha",
      "files_read",
      SKILL_LOAD,
    ]);
    const agent = await newAgent(app, { toolGrant: grant("allow", []) });
    res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Third",
      agentId: agent.id,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(toolNames(model.requests[2])).toEqual(["files_read", SKILL_LOAD]);
  });

  it("leaves out the skills of a deleted agent", async () => {
    const { app, runs, model, skills } = await setup([answer, answer]);
    const agent = await newAgent(app);
    skills.create({ scope: "agent", id: agent.id }, content());
    const s = await newSession(app);
    let res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
      agentId: agent.id,
    });
    await waitIdle(runs, res.body.runId as string);
    expect(systemOf(model.requests[0])).toContain("- my-skill:");
    await api(app, "DELETE", `/api/agents/${agent.id}`);
    res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Again",
    });
    await waitIdle(runs, res.body.runId as string);
    expect(systemOf(model.requests[1])).toBe("BASE");
    expect(toolNames(model.requests[1])).toEqual(["alpha", "files_read"]);
  });

  it("loads a body as a tool result, as the skill was when the run started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, runs, model, skills } = await setup([
      [
        { type: "wait", until: gate },
        {
          type: "tool_call",
          callId: "c1",
          name: SKILL_LOAD,
          arguments: JSON.stringify({ name: "my-skill" }),
        },
      ],
      answer,
    ]);
    const made = skills.create(GLOBAL, content({ body: "Version one." }));
    const s = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${s}/messages`, {
      content: "Hi",
    });
    const runId = res.body.runId as string;
    await expect.poll(() => model.requests.length).toBe(1);

    // An edit while the run is in progress applies from the next run.
    await api(
      app,
      "PUT",
      `/api/skills/${made.id}`,
      content({ body: "Version two." }),
    );
    release();
    await waitIdle(runs, runId);

    const detail = (await api(app, "GET", `/api/sessions/${s}`)).body as {
      messages: { message: { role: string; content: unknown } }[];
    };
    const result = detail.messages.find((m) => m.message.role === "tool");
    expect(result?.message.content).toBe("Version one.");
    // The model got the result in its second call.
    expect(
      JSON.stringify((model.requests[1] as ChatRequest).messages),
    ).toContain("Version one.");
  });
});
