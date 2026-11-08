import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { AgentStore } from "./agents-store.js";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";
import { setToolAsks } from "./tool-settings.js";
import { WorkspaceStore, WorkspaceStoreError } from "./workspaces-store.js";

/*
 * Workspaces (files unification design): the store, the routes, and real runs
 * through the tools with a scripted model.
 */

const TOKEN = "t".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function folder(files: Record<string, string | Buffer> = {}) {
  const base = mkdtempSync(join(tmpdir(), "harness-wsrun-"));
  const dir = join(base, "book");
  mkdirSync(dir);
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return dir;
}

async function setup(scripts: ScriptStep[][] = [], settings = {}) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  const entries = new EntryStore(t.db);
  const agents = new AgentStore(t.db);
  const workspaces = new WorkspaceStore(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    agents,
    entries,
    workspaces,
  });
  const app = buildServer({
    store,
    runs,
    entries,
    agents,
    workspaces,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, workspaces, scripts, agents };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

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

async function newSession(c: Ctx, projectId?: string) {
  const { body } = await api(c.app, "POST", "/api/sessions", {
    title: "T",
    ...(projectId ? { projectId } : {}),
  });
  return body.id as string;
}

interface Drive {
  decisions?: ("once" | "session" | "always" | "deny")[];
  forms?: (Record<string, unknown> | null)[];
}
/** Runs a message to its end, answering approvals and forms in order. */
async function go(c: Ctx, sessionId: string, drive: Drive = {}) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content: "Go",
  });
  expect(res.status).toBe(202);
  const runId = res.body.runId as string;
  const decisions = [...(drive.decisions ?? [])];
  const forms = [...(drive.forms ?? [])];
  const asked: { name: string; subject?: { id: string; label: string } }[] = [];
  const deadline = Date.now() + 8000;
  while (c.runs.isActive(runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end in time.");
    const live = c.runs.snapshot(sessionId);
    const run = live.activeRun;
    const approval = run?.approvals[0];
    if (run && approval) {
      asked.push({
        name: approval.name,
        ...(approval.subject ? { subject: approval.subject } : {}),
      });
      c.runs.answerApproval(run.runId, approval.requestId, {
        choice: decisions.shift() ?? "once",
      });
    }
    const input = run?.inputs[0];
    if (run && input) {
      const next = forms.shift() ?? null;
      c.runs.answerInput(
        run.runId,
        input.requestId,
        next ? { outcome: "answered", answers: next } : { outcome: "skipped" },
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return { runId, asked };
}

function results(c: Ctx, sessionId: string) {
  return c.store.listMessages(sessionId, "top").flatMap((m) =>
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
}

const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.name);

describe("WorkspaceStore", () => {
  it("creates a workspace with a full, existing folder and a unique name", async () => {
    const c = await setup();
    const dir = folder();
    const w = c.workspaces.create({ name: "Book", path: dir, writable: false });
    expect(w).toMatchObject({ name: "Book", path: dir, writable: false });
    const bad = (content: Parameters<WorkspaceStore["create"]>[0]) => {
      try {
        c.workspaces.create(content);
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceStoreError);
        return (err as WorkspaceStoreError).message;
      }
      throw new Error("It did not fail.");
    };
    expect(bad({ name: "A", path: "relative/dir", writable: false })).toMatch(
      /full path/,
    );
    expect(
      bad({ name: "A", path: join(dir, "nope"), writable: false }),
    ).toMatch(/no folder/);
    expect(
      bad({ name: "A", path: join(dir, "x.txt"), writable: false }),
    ).toMatch(/no folder/);
    expect(bad({ name: " ", path: dir, writable: false })).toMatch(/name/);
    expect(bad({ name: "Book", path: dir, writable: true })).toMatch(
      /already exists/,
    );
  });

  it("a project's and a session's attachments add up; read-only wins (D26)", async () => {
    const c = await setup();
    const dir = folder();
    const rw = c.workspaces.create({ name: "RW", path: dir, writable: true });
    const ro = c.workspaces.create({
      name: "RO",
      path: folder(),
      writable: false,
    });
    const both = c.workspaces.create({
      name: "Both",
      path: folder(),
      writable: true,
    });
    c.store.createProject({ id: "p1", name: "P", description: "", now: "t" });
    c.store.createSession("s1", "T", "t", "p1");
    c.workspaces.attach("project", "p1", rw.id, false);
    c.workspaces.attach("project", "p1", both.id, true);
    c.workspaces.attach("session", "s1", ro.id, false);
    // A session cannot make a workspace the project holds read-only writable.
    c.workspaces.attach("session", "s1", both.id, false);
    const effective = Object.fromEntries(
      c.workspaces
        .forSession("s1", "p1")
        .map((w) => [w.name, w.effectiveWritable]),
    );
    // A workspace that is not writable is never writable (RO), and a
    // read-only attachment of the project holds for the session (Both).
    expect(effective).toEqual({ Both: false, RO: false, RW: true });
    // A session of another project, or none, sees none of them.
    expect(c.workspaces.forSession("s2", null)).toEqual([]);
    // A session's own attachment can make it stricter.
    c.workspaces.attach("session", "s1", rw.id, true);
    expect(
      c.workspaces.forSession("s1", "p1").find((w) => w.name === "RW")
        ?.effectiveWritable,
    ).toBe(false);
  });

  it("the trash hides a workspace and keeps its attachments; restore brings it back (D46)", async () => {
    const c = await setup();
    const dir = folder({ "a.md": "A" });
    const w = c.workspaces.create({ name: "Book", path: dir, writable: true });
    c.workspaces.attach("session", "s1", w.id, false);
    c.workspaces.trash(w.id);
    expect(c.workspaces.list().map((x) => x.name)).toEqual([]);
    expect(c.workspaces.list(true).map((x) => x.name)).toEqual(["Book"]);
    expect(c.workspaces.forSession("s1", null)).toEqual([]);
    // The folder and its files are untouched.
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("A");
    expect(() => c.workspaces.attach("session", "s2", w.id, false)).toThrow(
      /trash/,
    );
    expect(() =>
      c.workspaces.update(w.id, { name: "X", path: dir, writable: true }),
    ).toThrow(/trash/);
    c.workspaces.restore(w.id);
    expect(c.workspaces.forSession("s1", null).map((x) => x.name)).toEqual([
      "Book",
    ]);
  });

  it("a name in the trash is still taken", async () => {
    const c = await setup();
    const w = c.workspaces.create({
      name: "Book",
      path: folder(),
      writable: false,
    });
    c.workspaces.trash(w.id);
    expect(() =>
      c.workspaces.create({ name: "Book", path: folder(), writable: false }),
    ).toThrow(/trash/);
  });

  it("purging a session or project drops its attachments and approvals", async () => {
    const c = await setup();
    const w = c.workspaces.create({
      name: "Book",
      path: folder(),
      writable: true,
    });
    c.store.createProject({ id: "p1", name: "P", description: "", now: "t" });
    c.store.createSession("s1", "T", "t", "p1");
    c.workspaces.attach("session", "s1", w.id, false);
    c.workspaces.attach("project", "p1", w.id, false);
    c.workspaces.allowSubjectForSession(
      "s1",
      "workspace_write",
      "workspace",
      w.id,
    );
    c.store.purgeSession("s1");
    expect(c.workspaces.attachments("session", "s1")).toEqual([]);
    expect(
      c.workspaces.isSubjectAllowedForSession(
        "s1",
        "workspace_write",
        "workspace",
        w.id,
      ),
    ).toBe(false);
    expect(c.workspaces.attachments("project", "p1")).toHaveLength(1);
    c.store.purgeProject("p1");
    expect(c.workspaces.attachments("project", "p1")).toEqual([]);
    // The workspace itself stays.
    expect(c.workspaces.get(w.id)).toBeDefined();
  });
});

describe("workspace routes", () => {
  it("creates, saves, trashes and restores", async () => {
    const c = await setup();
    const dir = folder();
    const made = await api(c.app, "POST", "/api/workspaces", {
      name: "Book",
      path: dir,
      writable: true,
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    expect(
      (await api(c.app, "GET", "/api/workspaces")).body.map(
        (w: Json) => w.name,
      ),
    ).toEqual(["Book"]);
    const saved = await api(c.app, "PUT", `/api/workspaces/${id}`, {
      name: "Novel",
      path: dir,
      writable: false,
    });
    expect(saved.body).toMatchObject({ name: "Novel", writable: false });
    expect((await api(c.app, "DELETE", `/api/workspaces/${id}`)).status).toBe(
      200,
    );
    expect((await api(c.app, "GET", "/api/workspaces")).body).toEqual([]);
    expect(
      (await api(c.app, "GET", "/api/workspaces?deleted=true")).body,
    ).toHaveLength(1);
    await api(c.app, "POST", `/api/workspaces/${id}/restore`);
    expect((await api(c.app, "GET", "/api/workspaces")).body).toHaveLength(1);
  });

  it("answers 400 for a missing folder and 409 for a taken name", async () => {
    const c = await setup();
    const dir = folder();
    const bad = await api(c.app, "POST", "/api/workspaces", {
      name: "A",
      path: join(dir, "nope"),
      writable: false,
    });
    expect(bad.status).toBe(400);
    await api(c.app, "POST", "/api/workspaces", {
      name: "A",
      path: dir,
      writable: false,
    });
    const dup = await api(c.app, "POST", "/api/workspaces", {
      name: "A",
      path: dir,
      writable: false,
    });
    expect(dup.status).toBe(409);
  });

  it("attaches to a project and a session, and a session shows the project's", async () => {
    const c = await setup();
    const w = c.workspaces.create({
      name: "Book",
      path: folder(),
      writable: true,
    });
    const other = c.workspaces.create({
      name: "Refs",
      path: folder(),
      writable: false,
    });
    const project = (
      await api(c.app, "POST", "/api/projects", { name: "P", description: "" })
    ).body.id as string;
    const session = await newSession(c, project);
    expect(
      (
        await api(c.app, "PUT", `/api/projects/${project}/workspaces/${w.id}`, {
          readOnly: true,
        })
      ).status,
    ).toBe(200);
    await api(c.app, "PUT", `/api/sessions/${session}/workspaces/${other.id}`, {
      readOnly: false,
    });
    const seen = (
      await api(c.app, "GET", `/api/sessions/${session}/workspaces`)
    ).body as Json[];
    expect(
      seen.map((a) => [
        a.workspace.name,
        a.from,
        a.readOnly,
        a.effectiveWritable,
      ]),
    ).toEqual([
      ["Book", "project", true, false],
      ["Refs", "session", false, false],
    ]);
    expect(
      (await api(c.app, "GET", `/api/projects/${project}/workspaces`)).body,
    ).toHaveLength(1);
    expect(
      (
        await api(
          c.app,
          "DELETE",
          `/api/sessions/${session}/workspaces/${other.id}`,
        )
      ).status,
    ).toBe(200);
    // Detaching what is not attached is a 404, and so is an unknown owner.
    expect(
      (
        await api(
          c.app,
          "DELETE",
          `/api/sessions/${session}/workspaces/${other.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(c.app, "GET", "/api/sessions/nope/workspaces")).status,
    ).toBe(404);
  });

  it("lists and revokes grants", async () => {
    const c = await setup();
    const w = c.workspaces.create({
      name: "Book",
      path: folder(),
      writable: true,
    });
    c.workspaces.grantSubject("workspace_write", "workspace", w.id);
    expect((await api(c.app, "GET", "/api/workspace-grants")).body).toEqual([
      { tool: "workspace_write", workspaceId: w.id, workspaceName: "Book" },
    ]);
    const gone = await api(c.app, "DELETE", "/api/workspace-grants", {
      tool: "workspace_write",
      workspaceId: w.id,
    });
    expect(gone.status).toBe(200);
    expect((await api(c.app, "GET", "/api/workspace-grants")).body).toEqual([]);
    expect(
      (
        await api(c.app, "DELETE", "/api/workspace-grants", {
          tool: "workspace_write",
          workspaceId: w.id,
        })
      ).status,
    ).toBe(404);
  });

  it("lists folders for the picker", async () => {
    const c = await setup();
    const dir = folder({ "a/x.md": "x", "b/y.md": "y", "file.md": "f" });
    const r = await api(
      c.app,
      "GET",
      `/api/fs/dirs?path=${encodeURIComponent(dir)}`,
    );
    expect(r.body).toMatchObject({ path: dir, dirs: ["a", "b"] });
    expect(r.body.parent).toBe(join(dir, ".."));
    expect(
      (
        await api(
          c.app,
          "GET",
          `/api/fs/dirs?path=${encodeURIComponent(join(dir, "file.md"))}`,
        )
      ).status,
    ).toBe(400);
  });
});

describe("workspace tools in a run", () => {
  async function withWorkspace(
    files: Record<string, string | Buffer>,
    writable: boolean,
    scripts: ScriptStep[][] = [],
    settings = {},
  ) {
    const c = await setup(scripts, settings);
    const dir = folder(files);
    const w = c.workspaces.create({ name: "Book", path: dir, writable });
    const id = await newSession(c);
    c.workspaces.attach("session", id, w.id, false);
    return { c, dir, w, id, ref: (p: string) => `workspace://${w.id}/${p}` };
  }

  it("offers the workspace tools only to a session that has one", async () => {
    const c = await setup([done, done]);
    const none = await newSession(c);
    await go(c, none);
    expect(toolNames(c.model.requests[0] as ChatRequest)).not.toContain(
      "workspace_read",
    );
    const w = c.workspaces.create({
      name: "Book",
      path: folder(),
      writable: false,
    });
    const some = await newSession(c);
    c.workspaces.attach("session", some, w.id, false);
    await go(c, some);
    expect(toolNames(c.model.requests[1] as ChatRequest)).toEqual(
      expect.arrayContaining([
        "workspaces_list",
        "workspace_list",
        "workspace_read",
        "workspace_write",
        "workspace_folder_delete",
      ]),
    );
  });

  it("lists the workspaces and a folder, and reads without asking", async () => {
    const { c, id, w, ref } = await withWorkspace(
      { "ch1.md": "# One", "notes/idea.txt": "x" },
      false,
    );
    c.scripts.push(
      [
        call("1", "workspaces_list"),
        call("2", "workspace_list", { folder: ref("") }),
        call("3", "workspace_list", { folder: ref("notes") }),
        call("4", "workspace_read", { path: ref("ch1.md") }),
      ],
      done,
    );
    const { asked } = await go(c, id);
    expect(asked).toEqual([]);
    const [a, b, d, e] = results(c, id);
    expect(a?.data.workspaces).toEqual([
      {
        id: w.id,
        name: "Book",
        writable: false,
        reference: `workspace://${w.id}/`,
      },
    ]);
    expect(b?.data.entries.map((x: Json) => x.path)).toEqual([
      "ch1.md",
      "notes",
    ]);
    expect(d?.data.entries.map((x: Json) => x.path)).toEqual([
      "notes/idea.txt",
    ]);
    expect(e?.data).toMatchObject({ text: "# One", length: 5, offset: 0 });
  });

  it("cuts a long read at the cap and reads on with offset (D47, D55)", async () => {
    const text = "0123456789".repeat(30);
    const { c, id, ref } = await withWorkspace({ "long.md": text }, false, [], {
      workspaceReadCap: 100,
    });
    c.scripts.push(
      [
        call("1", "workspace_read", { path: ref("long.md") }),
        call("2", "workspace_read", { path: ref("long.md"), offset: 100 }),
        call("3", "workspace_read", { path: ref("long.md"), offset: 250 }),
      ],
      done,
    );
    await go(c, id);
    const [first, second, last] = results(c, id);
    expect(first?.data.text).toHaveLength(100);
    expect(first?.data.note).toBe(
      "Characters 0 to 100 of 300. Read on with offset 100.",
    );
    expect(second?.data.text).toBe(text.slice(100, 200));
    expect(last?.data.note).toBeUndefined();
    expect(last?.data.text).toBe(text.slice(250));
  });

  it("a plain path works when there is one workspace", async () => {
    const { c, id } = await withWorkspace({ "ch1.md": "# One" }, false);
    c.scripts.push([call("1", "workspace_read", { path: "ch1.md" })], done);
    await go(c, id);
    expect(results(c, id)[0]?.data.text).toBe("# One");
  });

  it("shows an image to the model, and says so when it cannot", async () => {
    const { c, id, ref } = await withWorkspace({ "map.png": PNG }, false);
    c.scripts.push(
      [call("1", "workspace_read", { path: ref("map.png") })],
      done,
    );
    await go(c, id);
    const [r] = results(c, id);
    expect(r?.data.note).toMatch(/follows this result/);
    const second = c.model.requests[1] as ChatRequest;
    expect(second.resolveFile?.(ref("map.png"))).toMatchObject({
      kind: "image",
      mediaType: "image/png",
    });
    expect(second.resolveFile?.(ref("../x.png"))).toBeUndefined();
  });

  it("serves a workspace image to the chat", async () => {
    const { c, id, ref } = await withWorkspace({ "map.png": PNG }, false);
    const res = await c.app.inject({
      method: "GET",
      url: `/api/sessions/${id}/workspace-file?ref=${encodeURIComponent(ref("map.png"))}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    const missing = await c.app.inject({
      method: "GET",
      url: `/api/sessions/${id}/workspace-file?ref=${encodeURIComponent(ref("nope.png"))}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("asks before a change, naming the workspace, and writes when allowed", async () => {
    const { c, id, dir, w, ref } = await withWorkspace({}, true);
    c.scripts.push(
      [
        call("1", "workspace_write", {
          path: ref("new/ch1.md"),
          content: "Hi",
        }),
      ],
      done,
    );
    const { asked } = await go(c, id, { decisions: ["once"] });
    expect(asked).toEqual([
      {
        name: "workspace_write",
        subject: { kind: "workspace", id: w.id, label: "Book" },
      },
    ]);
    expect(readFileSync(join(dir, "new/ch1.md"), "utf8")).toBe("Hi");
    expect(results(c, id)[0]?.data).toMatchObject({ created: true, size: 2 });
  });

  it("does not change anything when denied", async () => {
    const { c, id, dir, ref } = await withWorkspace({}, true);
    c.scripts.push(
      [call("1", "workspace_write", { path: ref("a.md"), content: "Hi" })],
      done,
    );
    await go(c, id, { decisions: ["deny"] });
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(results(c, id)[0]?.isError).toBe(true);
  });

  it("refuses a change in a read-only workspace", async () => {
    const { c, id, dir, ref } = await withWorkspace({}, false);
    c.scripts.push(
      [call("1", "workspace_write", { path: ref("a.md"), content: "Hi" })],
      done,
    );
    await go(c, id, { decisions: ["once"] });
    expect(results(c, id)[0]).toMatchObject({
      isError: true,
      data: { error: expect.stringMatching(/read-only/) },
    });
    expect(existsSync(join(dir, "a.md"))).toBe(false);
  });

  it("a read-only attachment makes a writable workspace read-only here", async () => {
    const c = await setup();
    const dir = folder();
    const w = c.workspaces.create({ name: "Book", path: dir, writable: true });
    const id = await newSession(c);
    c.workspaces.attach("session", id, w.id, true);
    c.scripts.push(
      [
        call("1", "workspace_write", {
          path: `workspace://${w.id}/a.md`,
          content: "x",
        }),
      ],
      done,
    );
    await go(c, id);
    expect(results(c, id)[0]?.data.error).toMatch(/read-only/);
  });

  it("every changing tool works: edit, move, delete and the folder tools", async () => {
    const { c, id, dir, ref } = await withWorkspace(
      { "a.md": "one two", "old/x.md": "x" },
      true,
    );
    c.scripts.push(
      [
        call("1", "workspace_read", { path: ref("a.md") }),
        call("2", "workspace_edit", {
          path: ref("a.md"),
          oldText: "two",
          newText: "2",
        }),
        call("3", "workspace_move", { from: ref("a.md"), to: ref("b/a.md") }),
        call("4", "workspace_delete", { path: ref("b/a.md") }),
        call("5", "workspace_folder_create", { path: ref("fresh/inner") }),
        call("6", "workspace_folder_rename", {
          from: ref("old"),
          to: ref("older"),
        }),
        call("7", "workspace_folder_delete", { path: ref("older") }),
        call("8", "workspace_folder_delete", {
          path: ref("older"),
          recursive: true,
        }),
      ],
      done,
    );
    const { asked } = await go(c, id, {
      decisions: ["once", "once", "once", "once", "once", "once", "once"],
    });
    expect(asked.map((a) => a.name)).toEqual([
      "workspace_edit",
      "workspace_move",
      "workspace_delete",
      "workspace_folder_create",
      "workspace_folder_rename",
      "workspace_folder_delete",
      "workspace_folder_delete",
    ]);
    const r = results(c, id);
    // Deleting a folder with files in it needs recursive: only the first
    // delete is refused.
    expect(r.map((x) => x.isError)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(r[6]?.data.error).toMatch(/not empty/);
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(existsSync(join(dir, "b/a.md"))).toBe(false);
    expect(existsSync(join(dir, "fresh/inner"))).toBe(true);
    expect(existsSync(join(dir, "older"))).toBe(false);
  });

  it("refuses to replace a file that was not read, and one that changed since", async () => {
    const { c, id, dir, ref } = await withWorkspace({ "a.md": "old" }, true);
    c.scripts.push(
      [call("1", "workspace_write", { path: ref("a.md"), content: "new" })],
      done,
    );
    await go(c, id);
    expect(results(c, id)[0]?.data.error).toMatch(/not been read/);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("old");
  });

  it("refuses a path that leaves the folder, also through a symlink", async () => {
    const { c, id, dir, ref } = await withWorkspace({}, true);
    const secret = folder({ "key.txt": "TOP SECRET" });
    symlinkSync(secret, join(dir, "link"));
    c.scripts.push(
      [
        call("1", "workspace_read", { path: ref("link/key.txt") }),
        call("2", "workspace_read", { path: ref("../book/../x") }),
      ],
      done,
    );
    // Asked about the outside path, the user says no (the form is skipped).
    await go(c, id, { forms: [null, null] });
    const [a, b] = results(c, id);
    expect(a?.isError).toBe(true);
    expect(a?.data.error).toMatch(/outside the workspace folder/);
    expect(a?.data.error).toMatch(/did not allow/);
    expect(JSON.stringify(a)).not.toContain("TOP SECRET");
    expect(b?.isError).toBe(true);
    expect(b?.data.error).toMatch(/outside the workspace folder/);
  });

  it("asks the user to allow a path outside the folder, once", async () => {
    const { c, id, dir, ref } = await withWorkspace({}, true);
    const secret = folder({ "key.txt": "TOP SECRET" });
    symlinkSync(secret, join(dir, "link"));
    c.scripts.push(
      [
        call("1", "workspace_read", { path: ref("link/key.txt") }),
        call("2", "workspace_read", { path: ref("link/key.txt") }),
      ],
      done,
    );
    // Yes the first time, no the second: the answer is not remembered.
    await go(c, id, { forms: [{ allow: true }, { allow: false }] });
    const [a, b] = results(c, id);
    expect(a?.data.text).toBe("TOP SECRET");
    expect(b?.isError).toBe(true);
  });

  it("an approved outside write still asks for the change itself", async () => {
    const { c, id, dir, w } = await withWorkspace({}, true);
    const secret = folder();
    symlinkSync(secret, join(dir, "link"));
    c.scripts.push(
      [
        call("1", "workspace_write", {
          path: `workspace://${w.id}/link/out.md`,
          content: "ok",
        }),
      ],
      done,
    );
    const { asked } = await go(c, id, {
      decisions: ["once"],
      forms: [{ allow: true }],
    });
    expect(asked).toHaveLength(1);
    expect(readFileSync(join(secret, "out.md"), "utf8")).toBe("ok");
  });

  describe("approvals per workspace", () => {
    const write = (ref: (p: string) => string, n: string) =>
      call(n, "workspace_write", { path: ref(`${n}.md`), content: n });

    it("Allow for this session covers that tool in that workspace only", async () => {
      const { c, id, ref } = await withWorkspace({}, true);
      const other = c.workspaces.create({
        name: "Other",
        path: folder(),
        writable: true,
      });
      c.workspaces.attach("session", id, other.id, false);
      c.scripts.push(
        [
          write(ref, "a"),
          write(ref, "b"),
          call("c", "workspace_write", {
            path: `workspace://${other.id}/c.md`,
            content: "c",
          }),
        ],
        done,
      );
      const { asked } = await go(c, id, { decisions: ["session", "once"] });
      // The second write to Book is not asked; the one to Other is.
      expect(asked.map((a) => a.subject?.label)).toEqual(["Book", "Other"]);
    });

    it("Always allow covers that tool in that workspace, in any session", async () => {
      const { c, id, ref, w } = await withWorkspace({}, true);
      c.scripts.push([write(ref, "a"), write(ref, "b")], done);
      const first = await go(c, id, { decisions: ["always"] });
      expect(first.asked).toHaveLength(1);
      expect(c.workspaces.grantsFor("workspace")).toEqual([
        { tool: "workspace_write", subjectId: w.id },
      ]);
      // The global setting for the tool is untouched.
      const again = await newSession(c);
      c.workspaces.attach("session", again, w.id, false);
      c.scripts.push([write(ref, "c")], done);
      const second = await go(c, again);
      expect(second.asked).toEqual([]);
    });

    it("Always allow for one tool does not cover the others", async () => {
      const { c, id, ref } = await withWorkspace({ "x.md": "x" }, true);
      c.scripts.push(
        [
          write(ref, "a"),
          call("r", "workspace_read", { path: ref("x.md") }),
          call("d", "workspace_delete", { path: ref("a.md") }),
        ],
        done,
      );
      const { asked } = await go(c, id, { decisions: ["always", "once"] });
      expect(asked.map((a) => a.name)).toEqual([
        "workspace_write",
        "workspace_delete",
      ]);
    });

    it("a grant for one workspace does not cover another", async () => {
      const { c, id, ref } = await withWorkspace({}, true);
      const other = c.workspaces.create({
        name: "Other",
        path: folder(),
        writable: true,
      });
      c.workspaces.attach("session", id, other.id, false);
      c.scripts.push(
        [
          write(ref, "a"),
          call("b", "workspace_write", {
            path: `workspace://${other.id}/b.md`,
            content: "b",
          }),
        ],
        done,
      );
      const { asked } = await go(c, id, { decisions: ["always", "once"] });
      expect(asked.map((a) => a.subject?.label)).toEqual(["Book", "Other"]);
    });

    it("an agent's own setting to ask still asks, and cannot be always allowed", async () => {
      const { c, id, ref, w } = await withWorkspace({}, true);
      const agent = c.agents.create(null, {
        name: "Careful",
        description: "d",
        prompt: "p",
        toolGrant: grant("allow", [
          "workspace_write",
          "workspace_read",
          "workspace_list",
          "workspaces_list",
        ]),
        toolApproval: { workspace_write: true },
        subagent: false,
        childPrompt: null,
      } as never);
      c.store.setSessionChoices(id, { agentId: agent.id });
      c.workspaces.grantSubject("workspace_write", "workspace", w.id);
      c.scripts.push([write(ref, "a")], done);
      const { asked } = await go(c, id, { decisions: ["once"] });
      // The grant does not override what the agent says.
      expect(asked).toHaveLength(1);
    });

    it("a tool the user set not to ask runs without asking", async () => {
      const { c, id, ref } = await withWorkspace({}, true);
      const tool = allTools.find((t) => t.name === "workspace_write");
      if (!tool) throw new Error("no tool");
      setToolAsks(c.t.db, tool, false);
      c.scripts.push([write(ref, "a")], done);
      const { asked } = await go(c, id);
      expect(asked).toEqual([]);
    });

    it("tools without a subject are asked as before", () => {
      const tool = allTools.find((t) => t.name === "start_subagent");
      expect(tool?.approvalSubject).toBeUndefined();
    });
  });

  it("puts the workspaces in the system message with {{workspaces}}", async () => {
    const { c, id, w } = await withWorkspace({}, true, [done], {
      systemPrompt: "Folders:\n{{workspaces}}",
    });
    await go(c, id);
    const system = (c.model.requests[0] as ChatRequest).messages.find(
      (m) => m.role === "system",
    )?.content as string;
    expect(system).toBe(
      `Folders:\n- Book: workspace://${w.id}/ (can be changed)`,
    );
  });

  it("{{workspaces}} is empty without workspaces", async () => {
    const c = await setup([done], { systemPrompt: "A{{workspaces}}B" });
    const id = await newSession(c);
    await go(c, id);
    const system = (c.model.requests[0] as ChatRequest).messages.find(
      (m) => m.role === "system",
    )?.content as string;
    expect(system).toBe("AB");
  });
});
