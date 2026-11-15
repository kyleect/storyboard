import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import { FileStore } from "./files-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";
import { setToolAsks } from "./tool-settings.js";
import {
  WorkspaceStore,
  WorkspaceStoreError,
  type WorkspaceOwner,
} from "./workspaces-store.js";

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
  const files = new FileStore(t.db);
  const agents = new AgentStore(t.db);
  const tempRoot = mkdtempSync(join(tmpdir(), "harness-wstemp-"));
  cleanups.push(() => rmSync(tempRoot, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore(t.db, undefined, undefined, tempRoot);
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
    files,
    workspaces,
  });
  const app = buildServer({
    store,
    runs,
    files,
    agents,
    workspaces,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, workspaces, scripts, agents, tempRoot };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const GLOBAL = { scope: "global" } as const;

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
    const w = c.workspaces.create(GLOBAL, {
      name: "Book",
      path: dir,
      writable: false,
    });
    expect(w).toMatchObject({ name: "Book", path: dir, writable: false });
    const bad = (content: Parameters<WorkspaceStore["create"]>[1]) => {
      try {
        c.workspaces.create(GLOBAL, content);
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

  it("a session sees its own, its project's and the global workspaces, and no others (Q1 A)", async () => {
    const c = await setup();
    c.store.createProject({ id: "p1", name: "P", description: "", now: "t" });
    c.store.createProject({ id: "p2", name: "Q", description: "", now: "t" });
    c.store.createSession("s1", "T", "t", "p1");
    c.store.createSession("s2", "T", "t", "p2");
    const make = (name: string, owner: WorkspaceOwner) =>
      c.workspaces.create(owner, { name, path: folder(), writable: true });
    make("Global", GLOBAL);
    make("OfP1", { scope: "project", id: "p1" });
    make("OfP2", { scope: "project", id: "p2" });
    make("OfS1", { scope: "session", id: "s1" });
    make("OfS2", { scope: "session", id: "s2" });
    const names = (session: string, project: string | null) =>
      c.workspaces.forSession(session, project).map((w) => w.name);
    expect(names("s1", "p1")).toEqual(["Global", "OfP1", "OfS1"]);
    expect(names("s2", "p2")).toEqual(["Global", "OfP2", "OfS2"]);
    // A standalone session has no project's.
    expect(names("s3", null)).toEqual(["Global"]);
    expect(
      c.workspaces
        .forSession("s1", "p1")
        .map((w) => [w.name, w.scope, w.ownerId]),
    ).toEqual([
      ["Global", "global", null],
      ["OfP1", "project", "p1"],
      ["OfS1", "session", "s1"],
    ]);
  });

  it("a name is unique within one owner, not across owners (Q3 A)", async () => {
    const c = await setup();
    c.store.createProject({ id: "p1", name: "P", description: "", now: "t" });
    c.store.createSession("s1", "T", "t", "p1");
    c.store.createSession("s2", "T", "t", "p1");
    const make = (owner: WorkspaceOwner) =>
      c.workspaces.create(owner, {
        name: "scratch",
        path: folder(),
        writable: true,
      });
    make(GLOBAL);
    make({ scope: "project", id: "p1" });
    make({ scope: "session", id: "s1" });
    make({ scope: "session", id: "s2" });
    expect(() => make({ scope: "session", id: "s1" })).toThrow(
      /already exists/,
    );
    expect(() => make(GLOBAL)).toThrow(/already exists/);
    expect(c.workspaces.forSession("s1", "p1").map((w) => w.scope)).toEqual([
      "session",
      "project",
      "global",
    ]);
  });

  it("lists only what an owner defines, and the trash apart", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const g = c.workspaces.create(GLOBAL, {
      name: "G",
      path: folder(),
      writable: false,
    });
    c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "S", path: folder(), writable: false },
    );
    expect(c.workspaces.list(GLOBAL).map((w) => w.name)).toEqual(["G"]);
    expect(
      c.workspaces.list({ scope: "session", id: "s1" }).map((w) => w.name),
    ).toEqual(["S"]);
    c.workspaces.trash(g.id);
    expect(c.workspaces.list(GLOBAL)).toEqual([]);
    expect(c.workspaces.list(GLOBAL, true).map((w) => w.name)).toEqual(["G"]);
  });

  it("the trash hides a workspace; restore brings it back (D46)", async () => {
    const c = await setup();
    const dir = folder({ "a.md": "A" });
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "Book", path: dir, writable: true },
    );
    c.workspaces.trash(w.id);
    expect(c.workspaces.forSession("s1", null)).toEqual([]);
    // The folder and its files are untouched.
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("A");
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
    const w = c.workspaces.create(GLOBAL, {
      name: "Book",
      path: folder(),
      writable: false,
    });
    c.workspaces.trash(w.id);
    expect(() =>
      c.workspaces.create(GLOBAL, {
        name: "Book",
        path: folder(),
        writable: false,
      }),
    ).toThrow(/trash/);
  });

  it("purging a session or project deletes its workspaces and approvals, never a folder the user chose", async () => {
    const c = await setup();
    c.store.createProject({ id: "p1", name: "P", description: "", now: "t" });
    c.store.createSession("s1", "T", "t", "p1");
    const dir = folder({ "keep.md": "K" });
    const own = c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "Own", path: dir, writable: true },
    );
    const proj = c.workspaces.create(
      { scope: "project", id: "p1" },
      { name: "Proj", path: dir, writable: true },
    );
    const glob = c.workspaces.create(GLOBAL, {
      name: "Glob",
      path: dir,
      writable: true,
    });
    c.workspaces.grantSubject("workspace_write", "workspace", own.id);
    c.workspaces.allowSubjectForSession(
      "s1",
      "workspace_write",
      "workspace",
      glob.id,
    );
    const purged: string[] = [];
    c.store.onWorkspacesPurged = (ids) => purged.push(...ids);
    c.store.purgeSession("s1");
    expect(c.workspaces.get(own.id)).toBeUndefined();
    expect(
      c.workspaces.isSubjectGranted("workspace_write", "workspace", own.id),
    ).toBe(false);
    expect(
      c.workspaces.isSubjectAllowedForSession(
        "s1",
        "workspace_write",
        "workspace",
        glob.id,
      ),
    ).toBe(false);
    expect(c.workspaces.get(proj.id)).toBeDefined();
    expect(purged).toEqual([own.id]);
    c.store.purgeProject("p1");
    expect(c.workspaces.get(proj.id)).toBeUndefined();
    expect(purged).toEqual([own.id, proj.id]);
    // The global one and the user's folder stay.
    expect(c.workspaces.get(glob.id)).toBeDefined();
    expect(readFileSync(join(dir, "keep.md"), "utf8")).toBe("K");
  });

  it("purging also drops what was indexed for the workspace", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "Book", path: folder(), writable: false },
    );
    c.t.db
      .prepare(
        "INSERT INTO workspace_index_files (workspace_id, path, mtime_ms, size) VALUES (?, 'a.md', 1, 1)",
      )
      .run(w.id);
    c.t.db
      .prepare(
        `INSERT INTO chunks (profile_id, scope, owner_id, key, seq, text)
         VALUES ('default', 'workspace', ?, 'a.md', 0, 'lighthouse')`,
      )
      .run(w.id);
    c.store.purgeSession("s1");
    expect(
      c.t.db.prepare("SELECT count(*) AS n FROM workspace_index_files").get(),
    ).toEqual({ n: 0 });
    expect(
      c.t.db
        .prepare("SELECT count(*) AS n FROM chunks WHERE scope = 'workspace'")
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("temporary workspaces", () => {
  it("makes an empty folder in the temp root, owned by the session, writable (Q4 A, Q6 A)", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.createTemporary("s1", "Scratch");
    expect(w).toMatchObject({
      name: "Scratch",
      scope: "session",
      ownerId: "s1",
      temporary: true,
      writable: true,
    });
    expect(w.path).toBe(join(c.tempRoot, w.id));
    expect(existsSync(w.path)).toBe(true);
    expect(readdirSync(w.path)).toEqual([]);
    expect(c.workspaces.forSession("s1", null).map((x) => x.id)).toEqual([
      w.id,
    ]);
    expect(c.workspaces.forSession("s2", null)).toEqual([]);
  });

  it("needs a name that is free in the session, and cannot be made without a temp root", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    c.workspaces.createTemporary("s1", "Scratch");
    expect(() => c.workspaces.createTemporary("s1", "Scratch")).toThrow(
      /already exists/,
    );
    expect(() => c.workspaces.createTemporary("s1", " ")).toThrow(/name/);
    const bare = new WorkspaceStore(c.t.db);
    expect(() => bare.createTemporary("s1", "Other")).toThrow(/not available/);
  });

  it("can be renamed or made read-only, but its folder cannot be moved", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.createTemporary("s1", "Scratch");
    const elsewhere = folder();
    const saved = c.workspaces.update(w.id, {
      name: "Drafts",
      path: elsewhere,
      writable: false,
    });
    expect(saved).toMatchObject({
      name: "Drafts",
      writable: false,
      path: w.path,
    });
  });

  it("deleting it removes the folder and its rows; one on a chosen folder cannot be deleted this way", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.createTemporary("s1", "Scratch");
    writeFileSync(join(w.path, "a.md"), "A");
    c.workspaces.grantSubject("workspace_write", "workspace", w.id);
    c.workspaces.destroyTemporary(w.id);
    expect(existsSync(w.path)).toBe(false);
    expect(c.workspaces.get(w.id)).toBeUndefined();
    expect(
      c.workspaces.isSubjectGranted("workspace_write", "workspace", w.id),
    ).toBe(false);
    const real = c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "Real", path: folder(), writable: true },
    );
    expect(() => c.workspaces.destroyTemporary(real.id)).toThrow(/temporary/);
  });

  it("is kept while the session is in the trash and deleted with the session when it is purged (Q4 A)", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    const w = c.workspaces.createTemporary("s1", "Scratch");
    writeFileSync(join(w.path, "a.md"), "A");
    c.store.setSessionTrashed("s1", "t");
    expect(existsSync(join(w.path, "a.md"))).toBe(true);
    c.store.purgeSession("s1");
    expect(existsSync(w.path)).toBe(false);
    expect(c.workspaces.get(w.id)).toBeUndefined();
  });

  it("a fork shares a chosen folder and gets a copy of a temporary one (Q7 A)", async () => {
    const c = await setup();
    c.store.createSession("s1", "T", "t", null);
    c.store.createSession("s2", "T", "t", null);
    const dir = folder({ "x.md": "X" });
    const real = c.workspaces.create(
      { scope: "session", id: "s1" },
      { name: "Real", path: dir, writable: true },
    );
    const temp = c.workspaces.createTemporary("s1", "Scratch");
    writeFileSync(join(temp.path, "note.md"), "N");
    c.workspaces.setTicks(real.id, [""]);
    c.workspaces.allowSubjectForSession(
      "s1",
      "workspace_write",
      "workspace",
      temp.id,
    );
    c.workspaces.copySessionWorkspaces("s1", "s2");
    const copied = c.workspaces.forSession("s2", null);
    expect(copied.map((w) => [w.name, w.temporary])).toEqual([
      ["Real", false],
      ["Scratch", true],
    ]);
    const [copiedReal, copiedTemp] = copied;
    if (!copiedReal || !copiedTemp) throw new Error("Expected two workspaces.");
    expect(copiedReal.path).toBe(dir);
    expect(copiedReal.id).not.toBe(real.id);
    expect(copiedReal.ticks).toEqual([""]);
    expect(copiedTemp.path).not.toBe(temp.path);
    expect(readFileSync(join(copiedTemp.path, "note.md"), "utf8")).toBe("N");
    expect(
      c.workspaces.isSubjectAllowedForSession(
        "s2",
        "workspace_write",
        "workspace",
        copiedTemp.id,
      ),
    ).toBe(true);
    // Purging one session never removes the other's files.
    c.store.purgeSession("s1");
    expect(existsSync(join(copiedTemp.path, "note.md"))).toBe(true);
    expect(readFileSync(join(dir, "x.md"), "utf8")).toBe("X");
  });
});

describe("workspace routes", () => {
  it("creates, saves, trashes and restores at each scope", async () => {
    const c = await setup();
    const project = (
      await api(c.app, "POST", "/api/projects", { name: "P", description: "" })
    ).body.id as string;
    const session = await newSession(c, project);
    for (const base of [
      "/api/global/workspaces",
      `/api/projects/${project}/workspaces`,
      `/api/sessions/${session}/workspaces`,
    ]) {
      const dir = folder();
      const made = await api(c.app, "POST", base, {
        name: "Book",
        path: dir,
        writable: true,
      });
      expect(made.status).toBe(201);
      const id = made.body.id as string;
      expect(
        (await api(c.app, "GET", base)).body.map((w: Json) => w.name),
      ).toEqual(["Book"]);
      expect((await api(c.app, "GET", `/api/workspaces/${id}`)).body.id).toBe(
        id,
      );
      const saved = await api(c.app, "PUT", `/api/workspaces/${id}`, {
        name: "Novel",
        path: dir,
        writable: false,
      });
      expect(saved.body).toMatchObject({ name: "Novel", writable: false });
      expect((await api(c.app, "DELETE", `/api/workspaces/${id}`)).status).toBe(
        200,
      );
      expect((await api(c.app, "GET", base)).body).toEqual([]);
      expect(
        (await api(c.app, "GET", `${base}?deleted=true`)).body,
      ).toHaveLength(1);
      await api(c.app, "POST", `/api/workspaces/${id}/restore`);
      expect((await api(c.app, "GET", base)).body).toHaveLength(1);
    }
  });

  it("answers 400 for a missing folder, 409 for a taken name and 404 for an unknown owner", async () => {
    const c = await setup();
    const dir = folder();
    const url = "/api/global/workspaces";
    const bad = await api(c.app, "POST", url, {
      name: "A",
      path: join(dir, "nope"),
      writable: false,
    });
    expect(bad.status).toBe(400);
    await api(c.app, "POST", url, { name: "A", path: dir, writable: false });
    const dup = await api(c.app, "POST", url, {
      name: "A",
      path: dir,
      writable: false,
    });
    expect(dup.status).toBe(409);
    for (const base of ["/api/sessions/nope", "/api/projects/nope"]) {
      expect(
        (
          await api(c.app, "POST", `${base}/workspaces`, {
            name: "A",
            path: dir,
            writable: false,
          })
        ).status,
      ).toBe(404);
      expect((await api(c.app, "GET", `${base}/workspaces`)).status).toBe(404);
    }
  });

  it("a session's tools see its own, its project's and the global workspaces", async () => {
    const c = await setup();
    const project = (
      await api(c.app, "POST", "/api/projects", { name: "P", description: "" })
    ).body.id as string;
    const other = (
      await api(c.app, "POST", "/api/projects", { name: "Q", description: "" })
    ).body.id as string;
    const session = await newSession(c, project);
    const make = (base: string, name: string) =>
      api(c.app, "POST", base, { name, path: folder(), writable: true });
    await make("/api/global/workspaces", "Global");
    await make(`/api/projects/${project}/workspaces`, "Mine");
    await make(`/api/projects/${other}/workspaces`, "Theirs");
    await make(`/api/sessions/${session}/workspaces`, "Own");
    c.scripts.push([call("1", "workspaces_list")], done);
    await go(c, session);
    const listed = results(c, session)[0]?.data.workspaces as Json[];
    expect(listed.map((w) => w.name).sort()).toEqual(["Global", "Mine", "Own"]);
  });

  it("makes and deletes a temporary workspace", async () => {
    const c = await setup();
    const session = await newSession(c);
    const made = await api(
      c.app,
      "POST",
      `/api/sessions/${session}/workspaces/temporary`,
      { name: "Scratch" },
    );
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      temporary: true,
      scope: "session",
      writable: true,
    });
    const path = made.body.path as string;
    expect(existsSync(path)).toBe(true);
    const gone = await api(c.app, "DELETE", `/api/workspaces/${made.body.id}`);
    expect(gone.status).toBe(200);
    expect(existsSync(path)).toBe(false);
    expect(
      (
        await api(
          c.app,
          "GET",
          `/api/sessions/${session}/workspaces?deleted=true`,
        )
      ).body,
    ).toEqual([]);
    expect(
      (
        await api(c.app, "POST", "/api/sessions/nope/workspaces/temporary", {
          name: "X",
        })
      ).status,
    ).toBe(404);
  });

  it("shows a file for the Files tree: text, media and binary; refuses a path outside", async () => {
    const c = await setup();
    const dir = folder({
      "a.md": "# Title\n",
      "pic.png": PNG,
      "blob.bin": Buffer.from([0, 1, 2, 3]),
    });
    const w = c.workspaces.create(GLOBAL, {
      name: "Book",
      path: dir,
      writable: false,
    });
    const file = (path: string) =>
      api(
        c.app,
        "GET",
        `/api/workspaces/${w.id}/file?path=${encodeURIComponent(path)}`,
      );
    expect((await file("a.md")).body).toMatchObject({
      kind: "text",
      mediaType: "text/markdown",
      text: "# Title\n",
      truncated: false,
    });
    expect((await file("pic.png")).body).toMatchObject({
      kind: "media",
      mediaType: "image/png",
    });
    expect((await file("blob.bin")).body).toMatchObject({ kind: "binary" });
    const all = await api(c.app, "GET", `/api/workspaces/${w.id}/files`);
    expect(all.body).toMatchObject({ truncated: false, unavailable: false });
    expect(
      (all.body as { entries: { path: string }[] }).entries.map((e) => e.path),
    ).toEqual(["a.md", "blob.bin", "pic.png"]);
    expect((await file("../x")).status).toBe(400);
    expect((await file("missing.md")).status).toBe(404);
    const raw = await c.app.inject({
      method: "GET",
      url: `/api/workspaces/${w.id}/file/raw?path=pic.png`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("image/png");
    const notMedia = await c.app.inject({
      method: "GET",
      url: `/api/workspaces/${w.id}/file/raw?path=a.md`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(notMedia.statusCode).toBe(404);
  });

  it("lists and revokes grants", async () => {
    const c = await setup();
    const w = c.workspaces.create(GLOBAL, {
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
    const w = c.workspaces.create(GLOBAL, {
      name: "Book",
      path: dir,
      writable,
    });
    const id = await newSession(c);
    return { c, dir, w, id, ref: (p: string) => `workspace://${w.id}/${p}` };
  }

  it("offers the workspace tools only to a session that has one", async () => {
    const c = await setup([done, done]);
    const none = await newSession(c);
    await go(c, none);
    expect(toolNames(c.model.requests[0] as ChatRequest)).not.toContain(
      "workspace_read",
    );
    c.workspaces.create(GLOBAL, {
      name: "Book",
      path: folder(),
      writable: false,
    });
    const some = await newSession(c);
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
    expect(first?.data.guidance).toBe(
      "Characters 0 to 100 of 300. Read on with offset 100.",
    );
    expect(second?.data.text).toBe(text.slice(100, 200));
    expect(last?.data.guidance).toBeUndefined();
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
    expect(r?.data.guidance).toMatch(/follows this result/);
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

  it("a read-only workspace refuses a write, whoever owns it", async () => {
    const c = await setup();
    const dir = folder();
    const id = await newSession(c);
    const w = c.workspaces.create(
      { scope: "session", id },
      { name: "Book", path: dir, writable: false },
    );
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
    expect(existsSync(join(dir, "a.md"))).toBe(false);
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
      const other = c.workspaces.create(GLOBAL, {
        name: "Other",
        path: folder(),
        writable: true,
      });
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
      const other = c.workspaces.create(GLOBAL, {
        name: "Other",
        path: folder(),
        writable: true,
      });
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
      `Folders:\n- Book: workspace://${w.id}/ (global, can be changed)`,
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
