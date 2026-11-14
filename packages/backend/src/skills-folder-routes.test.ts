import { strToU8, zipSync } from "fflate";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, type ScriptStep } from "@harness/core";
import { skillLoad, skillsList } from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { buildSkillFile } from "./skill-frontmatter.js";
import { SkillStore } from "./skills-store.js";
import { Store } from "./store.js";
import { clearBuiltins, tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  clearBuiltins(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const agents = new AgentStore(t.db);
  const skills = new SkillStore(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [skillLoad],
    agents,
    skills,
    skillsList,
    systemPrompt: () => "BASE",
  });
  const app = buildServer({
    store,
    runs,
    agents,
    skills,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, app, skills, runs };
}

const json = async (
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    headers: auth,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: (res.body ? JSON.parse(res.body) : undefined) as Record<
      string,
      unknown
    >,
  };
};

const raw = (
  app: FastifyInstance,
  method: "POST" | "PUT",
  url: string,
  payload: Buffer,
) =>
  app.inject({
    method,
    url,
    headers: { ...auth, "content-type": "application/zip" },
    payload,
  });

const md = (name: string) => buildSkillFile(name, "Use when testing.", "Body.");
const zipOf = (entries: Record<string, string | Uint8Array>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([k, v]) => [
          k,
          typeof v === "string" ? strToU8(v) : v,
        ]),
      ),
    ),
  );

const BASE = "/api/global/skills";

describe("file routes", () => {
  it("writes, reads, moves and deletes files", async () => {
    const { app } = setup();
    const made = await json(app, "POST", BASE, {
      name: "my-skill",
      description: "d",
      body: "b",
    });
    const id = made.body.id as string;
    const put = await json(
      app,
      "PUT",
      `/api/skills/${id}/file?path=refs/a.md`,
      {
        value: "hello",
      },
    );
    expect(put.status).toBe(200);
    const got = await json(app, "GET", `/api/skills/${id}/file?path=refs/a.md`);
    expect(got.body).toMatchObject({ value: "hello", missing: false });
    const rawGet = await app.inject({
      method: "GET",
      url: `/api/skills/${id}/file/raw?path=refs/a.md`,
      headers: auth,
    });
    expect(rawGet.body).toBe("hello");
    expect(rawGet.headers["x-content-type-options"]).toBe("nosniff");
    const moved = await json(app, "POST", `/api/skills/${id}/move`, {
      from: "refs",
      to: "docs",
    });
    expect(moved.status).toBe(200);
    expect(
      (await json(app, "GET", `/api/skills/${id}/file?path=docs/a.md`)).status,
    ).toBe(200);
    const del = await json(app, "DELETE", `/api/skills/${id}/file?path=docs`);
    expect(del.status).toBe(200);
    expect(
      (await json(app, "GET", `/api/skills/${id}/file?path=docs/a.md`)).status,
    ).toBe(404);
    // A bad path and the SKILL.md itself.
    expect(
      (
        await json(app, "PUT", `/api/skills/${id}/file?path=../x`, {
          value: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (await json(app, "DELETE", `/api/skills/${id}/file?path=SKILL.md`))
        .status,
    ).toBe(400);
  });
});

describe("import and export routes", () => {
  it("previews, imports, and exports a zip", async () => {
    const { app } = setup();
    const zip = zipOf({
      "my-skill/SKILL.md": md("my-skill"),
      "my-skill/refs/g.md": "guide",
    });
    const preview = await raw(app, "POST", `${BASE}/import/preview`, zip);
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body)).toMatchObject({
      name: "my-skill",
      clash: null,
      files: [
        { path: "SKILL.md", size: expect.any(Number) },
        { path: "refs/g.md", size: 5 },
      ],
    });
    const imported = await raw(app, "POST", `${BASE}/import`, zip);
    expect(imported.statusCode).toBe(201);
    const id = JSON.parse(imported.body).id as string;

    const exported = await app.inject({
      method: "GET",
      url: `/api/skills/${id}/export`,
      headers: auth,
    });
    expect(exported.headers["content-type"]).toBe("application/zip");
    const back = await raw(
      app,
      "POST",
      `${BASE}/import/preview`,
      Buffer.from(exported.rawPayload),
    );
    expect(JSON.parse(back.body).files).toHaveLength(2);
  });

  it("asks on a name clash: refuses, replaces or renames", async () => {
    const { app, skills } = setup();
    const zip = zipOf({ "SKILL.md": md("my-skill"), "a.md": "one" });
    const first = JSON.parse(
      (await raw(app, "POST", `${BASE}/import`, zip)).body,
    ) as { id: string };
    const clash = await raw(app, "POST", `${BASE}/import`, zip);
    expect(clash.statusCode).toBe(409);
    const preview = await raw(app, "POST", `${BASE}/import/preview`, zip);
    expect(JSON.parse(preview.body).clash).toMatchObject({ id: first.id });

    const next = zipOf({ "SKILL.md": md("my-skill"), "b.md": "two" });
    const replaced = await raw(
      app,
      "POST",
      `${BASE}/import?resolve=replace`,
      next,
    );
    expect(replaced.statusCode).toBe(200);
    expect(skills.files(first.id).map((f) => f.path)).toEqual([
      "SKILL.md",
      "b.md",
    ]);

    const renamed = await raw(
      app,
      "POST",
      `${BASE}/import?resolve=rename&name=other-skill`,
      next,
    );
    expect(renamed.statusCode).toBe(201);
    const other = JSON.parse(renamed.body) as { id: string; name: string };
    expect(other.name).toBe("other-skill");
    expect(skills.skillFileText(other.id)).toContain("name: other-skill");
  });

  it("refuses a folder that does not match the name, and bad zips", async () => {
    const { app } = setup();
    const mismatch = await raw(
      app,
      "POST",
      `${BASE}/import`,
      zipOf({ "wrong/SKILL.md": md("my-skill") }),
    );
    expect(mismatch.statusCode).toBe(400);
    expect(JSON.parse(mismatch.body).error).toMatch(/must match/);
    const traversal = await raw(
      app,
      "POST",
      `${BASE}/import`,
      zipOf({ "SKILL.md": md("my-skill"), "../x": "x" }),
    );
    expect(traversal.statusCode).toBe(400);
    const junk = await raw(app, "POST", `${BASE}/import`, Buffer.from("nope"));
    expect(junk.statusCode).toBe(400);
  });
});

describe("runs pin a skill version", () => {
  it("records the version a run started with", async () => {
    const { app, skills, t, runs } = setup([[{ type: "text", text: "Done" }]]);
    const s = skills.create(
      { scope: "global" },
      { name: "my-skill", description: "d", body: "One." },
    );
    skills.updateText(s.id, { description: "d", body: "Two." });
    const session = (await json(app, "POST", "/api/sessions", {})).body
      .id as string;
    const res = await json(app, "POST", `/api/sessions/${session}/messages`, {
      content: "hi",
      agentId: null,
    });
    const runId = res.body.runId as string;
    await expect.poll(() => runs.isActive(runId)).toBe(false);
    const row = t.db
      .prepare("SELECT skill_versions FROM runs WHERE id = ?")
      .get(runId) as { skill_versions: string };
    expect(JSON.parse(row.skill_versions)).toEqual([
      { id: s.id, name: "my-skill", scope: "global", version: 2 },
    ]);
  });
});

describe("tree and copy routes", () => {
  it("lists skills with their files, and copies one to another scope", async () => {
    const { app } = setup();
    const made = await json(app, "POST", BASE, {
      name: "my-skill",
      description: "d",
      body: "b",
    });
    const id = made.body.id as string;
    await json(app, "PUT", `/api/skills/${id}/file?path=refs/a.md`, {
      value: "hi",
    });
    const plain = await json(app, "GET", BASE);
    expect((plain.body as unknown as { files?: unknown }[])[0]?.files).toBe(
      undefined,
    );
    const tree = await json(app, "GET", `${BASE}?files=true`);
    const [first] = tree.body as unknown as {
      name: string;
      files: { path: string; hash: string | null }[];
    }[];
    expect(first?.files.map((f) => f.path)).toEqual(["SKILL.md", "refs/a.md"]);
    expect(first?.files[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    const project = (await json(app, "POST", "/api/projects", { name: "P" }))
      .body.id as string;
    const copied = await json(
      app,
      "POST",
      `/api/projects/${project}/skills/copy`,
      {
        id,
      },
    );
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({ name: "my-skill", projectId: project });
    const again = await json(
      app,
      "POST",
      `/api/projects/${project}/skills/copy`,
      {
        id,
      },
    );
    expect(again.status).toBe(409);
    expect(
      (await json(app, "POST", `${BASE}/copy`, { id: "nope" })).status,
    ).toBe(404);
    // The file's own hash is the one the blobs route serves.
    const file = await json(
      app,
      "GET",
      `/api/skills/${id}/file?path=refs/a.md`,
    );
    expect(file.body.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
