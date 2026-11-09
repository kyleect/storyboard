import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
} from "@harness/core";
import { allTools } from "@harness/tools";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { SearchIndex } from "./search-index.js";
import { searchWorkspaces } from "./search.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";
import { WorkspaceIndexer } from "./workspace-index.js";
import { WorkspaceStore } from "./workspaces-store.js";

/* What is searched in a workspace: the routes and the tool in a real run. */

const TOKEN = "t".repeat(64);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function folder(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), "harness-wssearch-"));
  const dir = join(base, "book");
  mkdirSync(dir);
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return dir;
}

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  const entries = new EntryStore(t.db);
  const workspaces = new WorkspaceStore(t.db);
  const index = new SearchIndex(t.db);
  const indexer = new WorkspaceIndexer({
    store: workspaces,
    index,
    watch: false,
  });
  const engine = {
    index,
    embeddingModel: () => "",
    embed: () => Promise.resolve([]),
  };
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    entries,
    workspaces,
    workspaceIndex: {
      scanAll: (ids) => indexer.scanAll(ids),
      files: (id) => indexer.fileCount(id),
      search: (q) => searchWorkspaces(engine, q),
    },
  });
  const app = buildServer({
    store,
    runs,
    entries,
    workspaces,
    workspaceIndexer: indexer,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(
    () => indexer.stop(),
    t.cleanup,
    () => app.close(),
  );
  return { t, store, runs, app, model, workspaces, indexer, scripts };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

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
    body: (String(res.headers["content-type"] ?? "").includes("json")
      ? res.json()
      : undefined) as Json,
  };
}

const call = (callId: string, name: string, args: object = {}): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const done: ScriptStep[] = [{ type: "text", text: "done" }];

async function run(c: Ctx, sessionId: string) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content: "Go",
  });
  expect(res.status).toBe(202);
  const deadline = Date.now() + 8000;
  while (c.runs.isActive(res.body.runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end.");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const results = (c: Ctx, sessionId: string) =>
  c.store.listMessages(sessionId, "top").flatMap((m) =>
    m.message.role === "tool"
      ? [
          {
            name: m.message.name,
            isError: m.message.isError,
            data: m.message.data as Json,
          },
        ]
      : [],
  );

async function withWorkspace(
  files: Record<string, string>,
  scripts: ScriptStep[][] = [],
) {
  const c = await setup(scripts);
  const dir = folder(files);
  const w = c.workspaces.create({ name: "Book", path: dir, writable: true });
  const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
  const id = body.id as string;
  c.workspaces.attach("session", id, w.id, false);
  return { c, dir, w, id };
}

describe("the tick routes", () => {
  it("ticks, unticks, and shows the tree with its states", async () => {
    const { c, w } = await withWorkspace({
      "a.md": "alpha",
      "notes/b.md": "bravo",
      "notes/c.md": "charlie",
    });
    const tree = async (path = "") =>
      (await api(c.app, "GET", `/api/workspaces/${w.id}/tree?path=${path}`))
        .body;
    expect((await tree()).entries).toEqual([
      { name: "notes", path: "notes", kind: "folder", state: "none" },
      { name: "a.md", path: "a.md", kind: "file", state: "none" },
    ]);

    const on = await api(
      c.app,
      "POST",
      `/api/workspaces/${w.id}/ticks/toggle`,
      {
        path: "notes",
        on: true,
      },
    );
    expect(on.body.ticks).toEqual(["notes"]);
    expect(on.body.status).toMatchObject({ files: 2, scanning: false });
    expect((await tree()).entries.map((e: Json) => e.state)).toEqual([
      "all",
      "none",
    ]);

    // Unticking one file in a ticked folder ticks the rest of it.
    const off = await api(
      c.app,
      "POST",
      `/api/workspaces/${w.id}/ticks/toggle`,
      {
        path: "notes/b.md",
        on: false,
      },
    );
    expect(off.body.ticks).toEqual(["notes/c.md"]);
    expect((await tree()).entries[0].state).toBe("some");
    expect((await tree("notes")).entries.map((e: Json) => e.state)).toEqual([
      "none",
      "all",
    ]);

    const index = await api(c.app, "GET", `/api/workspaces/${w.id}/index`);
    expect(index.body).toMatchObject({
      ticks: ["notes/c.md"],
      status: { files: 1, chunks: 1 },
    });
  });

  it("saves a whole set of ticks, and rescans on request", async () => {
    const { c, w, dir } = await withWorkspace({ "a.md": "alpha" });
    const put = await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, {
      ticks: [""],
    });
    expect(put.body.status.files).toBe(1);
    writeFileSync(join(dir, "b.md"), "bravo");
    const scan = await api(c.app, "POST", `/api/workspaces/${w.id}/rescan`);
    expect(scan.body).toMatchObject({ indexed: 1, files: 2 });
  });

  it("refuses a path out of the folder, a missing workspace and one in the trash", async () => {
    const { c, w } = await withWorkspace({ "a.md": "alpha" });
    for (const path of ["../x", "a/../../x"]) {
      expect(
        (
          await api(c.app, "POST", `/api/workspaces/${w.id}/ticks/toggle`, {
            path,
            on: true,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, {
          ticks: ["../x"],
        })
      ).status,
    ).toBe(400);
    expect((await api(c.app, "GET", "/api/workspaces/nope/tree")).status).toBe(
      404,
    );
    expect(
      (await api(c.app, "GET", `/api/workspaces/${w.id}/tree?path=nope`))
        .status,
    ).toBe(404);
    await api(c.app, "DELETE", `/api/workspaces/${w.id}`);
    for (const [method, url] of [
      ["GET", `/api/workspaces/${w.id}/tree`],
      ["POST", `/api/workspaces/${w.id}/rescan`],
    ] as const) {
      expect((await api(c.app, method, url)).status).toBe(409);
    }
    expect(
      (
        await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, {
          ticks: [""],
        })
      ).status,
    ).toBe(409);
  });

  it("drops the index with the trash, and brings it back on restore", async () => {
    const { c, w } = await withWorkspace({ "a.md": "alpha" });
    await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, { ticks: [""] });
    const chunks = () =>
      (
        c.t.db
          .prepare("SELECT count(*) AS n FROM chunks WHERE scope = 'workspace'")
          .get() as { n: number }
      ).n;
    expect(chunks()).toBe(1);
    await api(c.app, "DELETE", `/api/workspaces/${w.id}`);
    expect(chunks()).toBe(0);
    await api(c.app, "POST", `/api/workspaces/${w.id}/restore`);
    expect(chunks()).toBe(1);
  });

  it("re-indexes when the workspace's folder is changed", async () => {
    const { c, w } = await withWorkspace({ "a.md": "alpha" });
    await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, { ticks: [""] });
    const other = folder({ "z.md": "zulu", "y.md": "yankee" });
    await api(c.app, "PUT", `/api/workspaces/${w.id}`, {
      name: "Book",
      path: other,
      writable: true,
    });
    expect(c.indexer.status(w.id).files).toBe(2);
  });
});

describe("workspace_search in a run", () => {
  it("finds a ticked file by its words and gives its reference", async () => {
    const { c, id, w } = await withWorkspace({
      "notes/keeper.md": "The lighthouse keeper wrote letters.",
      "notes/market.md": "A quiet market in spring.",
    });
    await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, {
      ticks: ["notes"],
    });
    c.scripts.push(
      [call("1", "workspace_search", { query: "lighthouse" })],
      done,
    );
    await run(c, id);
    const [r] = results(c, id);
    expect(r?.isError).toBe(false);
    expect(r?.data.hits).toEqual([
      {
        reference: `workspace://${w.id}/notes/keeper.md`,
        workspace: "Book",
        excerpt: "The lighthouse keeper wrote letters.",
        matched: "keyword",
      },
    ]);
    expect(r?.data.note).toBeUndefined();
  });

  it("says nothing is indexed when nothing is ticked", async () => {
    const { c, id } = await withWorkspace({ "a.md": "lighthouse" });
    c.scripts.push(
      [call("1", "workspace_search", { query: "lighthouse" })],
      done,
    );
    await run(c, id);
    const [r] = results(c, id);
    expect(r?.data.hits).toEqual([]);
    expect(r?.data.note).toMatch(/Nothing in these workspaces is indexed/);
  });

  it("searches only the workspaces of the session, and only what is ticked", async () => {
    const { c, id, w } = await withWorkspace({
      "a.md": "the lighthouse",
      "b.md": "also a lighthouse",
    });
    await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, {
      ticks: ["a.md"],
    });
    const other = c.workspaces.create({
      name: "Other",
      path: folder({ "o.md": "a lighthouse elsewhere" }),
      writable: false,
    });
    await api(c.app, "PUT", `/api/workspaces/${other.id}/ticks`, {
      ticks: [""],
    });
    c.scripts.push(
      [call("1", "workspace_search", { query: "lighthouse" })],
      done,
    );
    await run(c, id);
    const [r] = results(c, id);
    expect(r?.data.hits.map((h: Json) => h.reference)).toEqual([
      `workspace://${w.id}/a.md`,
    ]);
  });

  it("is not offered to a session without a workspace", async () => {
    const c = await setup([done]);
    const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
    await run(c, body.id);
    const names = ((c.model.requests[0] as ChatRequest).tools ?? []).map(
      (t) => t.name,
    );
    expect(names).not.toContain("workspace_search");
  });

  it("rescans when a session starts, so a change made while the app was closed is found", async () => {
    const { c, id, w, dir } = await withWorkspace({ "a.md": "alpha" });
    await api(c.app, "PUT", `/api/workspaces/${w.id}/ticks`, { ticks: [""] });
    // Changed on disk with nothing watching.
    writeFileSync(join(dir, "new.md"), "a zeppelin over the bay");
    renameSync(join(dir, "a.md"), join(dir, "moved.md"));
    c.scripts.push(
      [call("1", "workspace_search", { query: "zeppelin" })],
      done,
    );
    await run(c, id);
    const [r] = results(c, id);
    expect(r?.data.hits.map((h: Json) => h.reference)).toEqual([
      `workspace://${w.id}/new.md`,
    ]);
    expect(c.indexer.status(w.id).files).toBe(2);
  });
});
