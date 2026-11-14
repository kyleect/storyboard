import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ScriptedModel, type ScriptStep } from "@harness/core";
import { allTools } from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { AppEvents, type AppEvent } from "./app-events.js";
import { FileStore } from "./files-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";

/* The profile routes: managing profiles and switching (profiles design 4.3). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const risky = defineTool({
  name: "risky",
  description: "Asks first.",
  input: z.object({ text: z.string() }),
  approval: "ask",
  group: "utilities",
  alwaysOn: false,
  execute: () => ({ data: { ok: true } }),
});

async function setup(
  scripts: ScriptStep[][] = [],
  onProfileSwitched?: () => Promise<void>,
) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const files = new FileStore(t.db);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel(scripts);
  const events = new AppEvents();
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [risky, ...allTools],
    agents,
    files,
    systemPrompt: () => "BASE",
    events,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    files,
    events,
    token: TOKEN,
    env: {},
    ...(onProfileSwitched ? { onProfileSwitched } : {}),
  });
  await app.ready();
  const seen: AppEvent[] = [];
  const stop = events.subscribe((e) => seen.push(e));
  cleanups.push(t.cleanup, () => app.close(), stop);
  return { store, agents, runs, app, seen, db: t.db };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
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

interface Listing {
  active: string;
  profiles: { id: string; name: string; active: boolean }[];
  trashed: { id: string }[];
}
const listing = async (c: Ctx) =>
  (await api(c.app, "GET", "/api/profiles")).body as unknown as Listing;

const types = (c: Ctx) => c.seen.map((e) => e.type);

describe("profile routes", () => {
  it("lists the Default profile first, active", async () => {
    const c = await setup();
    const l = await listing(c);
    expect(l.active).toBe("default");
    expect(l.profiles).toHaveLength(1);
    expect(l.profiles[0]).toMatchObject({
      id: "default",
      name: "Default",
      active: true,
    });
    expect(l.trashed).toEqual([]);
  });

  it("needs the API token like every route", async () => {
    const c = await setup();
    const res = await c.app.inject({ method: "GET", url: "/api/profiles" });
    expect(res.statusCode).toBe(401);
  });

  it("creates, renames, trashes and restores, announcing each change", async () => {
    const c = await setup();
    const created = await api(c.app, "POST", "/api/profiles", { name: "Work" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect(
      (await api(c.app, "PUT", `/api/profiles/${id}`, { name: " Job " })).body
        .name,
    ).toBe("Job");
    expect((await api(c.app, "POST", `/api/profiles/${id}/trash`)).status).toBe(
      200,
    );
    expect((await listing(c)).trashed.map((p) => p.id)).toEqual([id]);
    expect(
      (await api(c.app, "POST", `/api/profiles/${id}/restore`)).status,
    ).toBe(200);
    expect((await listing(c)).trashed).toEqual([]);
    expect(types(c)).toEqual([
      "profiles.changed",
      "profiles.changed",
      "profiles.changed",
      "profiles.changed",
    ]);
  });

  it("answers 400, 404 and 409 where a profile cannot be changed", async () => {
    const c = await setup();
    expect(
      (await api(c.app, "POST", "/api/profiles", { name: " " })).status,
    ).toBe(400);
    expect(
      (await api(c.app, "POST", "/api/profiles", { name: "Default" })).status,
    ).toBe(409);
    expect(
      (await api(c.app, "PUT", "/api/profiles/nope", { name: "x" })).status,
    ).toBe(404);
    // The Default profile is also the active one.
    expect(
      (await api(c.app, "POST", "/api/profiles/default/trash")).status,
    ).toBe(409);
  });

  it("switches, announces it, and runs the reload hook once", async () => {
    let reloads = 0;
    const c = await setup([], async () => {
      reloads++;
    });
    const id = (await api(c.app, "POST", "/api/profiles", { name: "Work" }))
      .body.id as string;

    const res = await api(c.app, "POST", `/api/profiles/${id}/switch`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(id);
    expect(reloads).toBe(1);
    expect(c.seen.at(-1)).toEqual({
      type: "profile.switched",
      data: { profileId: id },
    });

    // Switching to the profile that is already active does nothing.
    await api(c.app, "POST", `/api/profiles/${id}/switch`);
    expect(reloads).toBe(1);
    expect(c.seen.filter((e) => e.type === "profile.switched")).toHaveLength(1);
  });

  it("hides the other profile's sessions and settings until switched back", async () => {
    const c = await setup();
    writeSettings(c.db, { model: "in-default" });
    const session = (
      await api(c.app, "POST", "/api/sessions", { title: "Draft" })
    ).body.id as string;
    const work = (await api(c.app, "POST", "/api/profiles", { name: "Work" }))
      .body.id as string;

    await api(c.app, "POST", `/api/profiles/${work}/switch`);
    expect((await api(c.app, "GET", `/api/sessions/${session}`)).status).toBe(
      404,
    );
    expect(
      ((await api(c.app, "GET", "/api/sessions")).body.sessions as unknown[]) ??
        [],
    ).toEqual([]);
    expect(
      (
        (await api(c.app, "GET", "/api/settings")).body as {
          effective: { model: string };
        }
      ).effective.model,
    ).toBe("");

    await api(c.app, "POST", "/api/profiles/default/switch");
    expect((await api(c.app, "GET", `/api/sessions/${session}`)).status).toBe(
      200,
    );
    expect(
      (
        (await api(c.app, "GET", "/api/settings")).body as {
          effective: { model: string };
        }
      ).effective.model,
    ).toBe("in-default");
  });

  it("refuses to switch to a profile in the trash, or one that is unknown", async () => {
    const c = await setup();
    const id = (await api(c.app, "POST", "/api/profiles", { name: "Old" })).body
      .id as string;
    await api(c.app, "POST", `/api/profiles/${id}/trash`);
    const trashed = await api(c.app, "POST", `/api/profiles/${id}/switch`);
    expect(trashed.status).toBe(409);
    expect(trashed.body.error).toMatch(/trash/);
    expect((await api(c.app, "POST", "/api/profiles/nope/switch")).status).toBe(
      404,
    );
    expect((await listing(c)).active).toBe("default");
  });

  it("keeps the switch when the reload hook fails", async () => {
    const c = await setup([], async () => {
      throw new Error("indexer down");
    });
    const id = (await api(c.app, "POST", "/api/profiles", { name: "Work" }))
      .body.id as string;
    const res = await api(c.app, "POST", `/api/profiles/${id}/switch`);
    expect(res.status).toBe(200);
    expect((await listing(c)).active).toBe(id);
    expect(c.seen.at(-1)?.type).toBe("profile.switched");
  });

  it("refuses to switch while a run is active, naming the session", async () => {
    const c = await setup([
      [
        {
          type: "tool_call",
          callId: "c1",
          name: "risky",
          arguments: JSON.stringify({ text: "a" }),
        },
      ],
      [{ type: "text", text: "Done" }],
    ]);
    const agent = c.agents.create(null, {
      name: "Editor",
      description: "",
      prompt: "p",
      toolGrant: grant("allow", ["risky"]),
      toolApproval: {},
    });
    const work = (await api(c.app, "POST", "/api/profiles", { name: "Work" }))
      .body.id as string;
    const sessionId = (
      await api(c.app, "POST", "/api/sessions", { title: "Chapter one" })
    ).body.id as string;
    c.store.setSessionChoices(sessionId, { agentId: agent.id });
    const sent = await api(
      c.app,
      "POST",
      `/api/sessions/${sessionId}/messages`,
      {
        content: "Go",
      },
    );
    expect(sent.status).toBe(202);

    // The run now waits for an approval; it is still a run in progress.
    await expect
      .poll(() => c.runs.activeRuns().some((r) => r.waiting))
      .toBe(true);
    const refused = await api(c.app, "POST", `/api/profiles/${work}/switch`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Chapter one");
    expect((await listing(c)).active).toBe("default");
    expect(c.seen.some((e) => e.type === "profile.switched")).toBe(false);

    const open = c.runs.snapshot(sessionId).activeRun?.approvals[0];
    c.runs.answerApproval(sent.body.runId as string, open?.requestId ?? "", {
      choice: "once",
    });
    await expect.poll(() => c.runs.activeRuns().length).toBe(0);

    const ok = await api(c.app, "POST", `/api/profiles/${work}/switch`);
    expect(ok.status).toBe(200);
  });
});
