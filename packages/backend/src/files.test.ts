import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type Message,
  type ScriptStep,
} from "@harness/core";
import { allTools, filesInstruction } from "@harness/tools";
import { FileStore } from "./files-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { runAnsweringForms, tempDatabase } from "./test-helpers.js";

/* Files and memory (files and memory design): routes, tools, purge. */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  // No global system prompt, so the system message is only what each test sets.
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let clock = 0;
  const now = () =>
    new Date(Date.UTC(2026, 10, 1, 0, 0, ++clock))
      .toISOString()
      .replace(".000Z", "Z");
  const files = new FileStore(t.db, now);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    files,
    systemPrompt: (s) => filesInstruction(s.project_id !== null),
    now,
  });
  const app = buildServer({ store, runs, files, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, files };
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (res.body ? res.json() : undefined) as any,
  };
}

async function newSession(app: FastifyInstance, projectId?: string) {
  const { body } = await api(app, "POST", "/api/sessions", {
    title: "Test",
    ...(projectId ? { projectId } : {}),
  });
  return body.id as string;
}

async function newProject(app: FastifyInstance) {
  const { body } = await api(app, "POST", "/api/projects", { name: "P" });
  return body.id as string;
}

/** Sends a message and waits for the run, answering its forms in order. */
async function send(
  app: FastifyInstance,
  runs: RunManager,
  id: string,
  answers: Record<string, unknown>[] = [],
) {
  const run = await api(app, "POST", `/api/sessions/${id}/messages`, {
    content: "Go",
  });
  expect(run.status).toBe(202);
  await runAnsweringForms(runs, id, run.body.runId as string, answers);
  return run.body.runId as string;
}

const call = (callId: string, name: string, args: object): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});

describe("global files", () => {
  it("creates, replaces, deletes and restores, keeping every version", async () => {
    const { app } = await setup();
    const put = (value: string) =>
      api(app, "PUT", "/api/global/files/style.md", {
        mediaType: "text/markdown",
        value,
      });
    expect((await put("v1")).status).toBe(200);
    const second = await put("v2");
    expect(second.body).toMatchObject({
      key: "style.md",
      mediaType: "text/markdown",
      value: "v2",
      deleted: false,
    });
    expect(second.body.versions).toHaveLength(2);

    expect(
      (await api(app, "DELETE", "/api/global/files/style.md")).status,
    ).toBe(204);
    expect((await api(app, "GET", "/api/global/files")).body).toEqual([]);
    expect(
      (await api(app, "GET", "/api/global/files?deleted=true")).body,
    ).toMatchObject([{ key: "style.md", deleted: true, value: "v2" }]);

    const restored = await api(
      app,
      "POST",
      "/api/global/files/style.md/restore",
      { seq: 1 },
    );
    expect(restored.body).toMatchObject({ value: "v1", deleted: false });
    expect(
      restored.body.versions.map((v: { value: string; deleted: boolean }) => [
        v.value,
        v.deleted,
      ]),
    ).toEqual([
      ["v1", false],
      ["v2", false],
      ["v2", true],
      ["v1", false],
    ]);
    expect(restored.body.versions[0]).toMatchObject({
      by: "user",
      sessionId: null,
      runId: null,
    });
  });

  it("rejects bad keys, invalid JSON, a deletion as restore target, and missing files", async () => {
    const { app } = await setup();
    expect(
      (
        await api(app, "PUT", "/api/global/files/CON", {
          mediaType: "text/plain",
          value: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, "PUT", "/api/global/files/a", {
          mediaType: "application/json",
          value: "{",
        })
      ).status,
    ).toBe(400);
    expect((await api(app, "GET", "/api/global/files/none")).status).toBe(404);
    expect((await api(app, "DELETE", "/api/global/files/none")).status).toBe(
      404,
    );
    await api(app, "PUT", "/api/global/files/a", {
      mediaType: "text/plain",
      value: "x",
    });
    await api(app, "DELETE", "/api/global/files/a");
    expect(
      (await api(app, "POST", "/api/global/files/a/restore", { seq: 2 }))
        .status,
    ).toBe(400);
    expect(
      (await api(app, "POST", "/api/global/files/a/restore", { seq: 9 }))
        .status,
    ).toBe(404);
  });

  it("does not let the user create notes", async () => {
    const { app } = await setup();
    expect(
      (await api(app, "PUT", "/api/global/notes/n1", { text: "x" })).status,
    ).toBe(404);
    expect(
      (await api(app, "PATCH", "/api/global/notes/n1", { text: "x" })).status,
    ).toBe(404);
  });
});

describe("project files", () => {
  it("keeps a project's files apart from global ones with the same key", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    await api(app, "PUT", `/api/projects/${p}/files/a`, {
      mediaType: "text/plain",
      value: "project",
    });
    await api(app, "PUT", "/api/global/files/a", {
      mediaType: "text/plain",
      value: "global",
    });
    expect(
      (await api(app, "GET", `/api/projects/${p}/files/a`)).body.value,
    ).toBe("project");
    expect((await api(app, "GET", "/api/global/files/a")).body.value).toBe(
      "global",
    );
    expect((await api(app, "GET", "/api/projects/nope/files")).status).toBe(
      404,
    );
  });

  it("is read-only while the project is in the trash", async () => {
    const { app } = await setup();
    const p = await newProject(app);
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect(
      (
        await api(app, "PUT", `/api/projects/${p}/files/a`, {
          mediaType: "text/plain",
          value: "x",
        })
      ).status,
    ).toBe(409);
    expect((await api(app, "GET", `/api/projects/${p}/files`)).status).toBe(
      200,
    );
  });
});

describe("the model's tools", () => {
  it("writes every scope, with versions naming the session and run", async () => {
    const { app, runs, model, store } = await setup([
      [
        call("c1", "files_write", {
          scope: "session",
          key: "plan.md",
          mediaType: "text/markdown",
          value: "# Plan",
        }),
        call("c2", "files_write", {
          scope: "global",
          key: "style",
          mediaType: "text/plain",
          value: "terse",
        }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const p = await newProject(app);
    const id = await newSession(app, p);
    // The user confirms the scope of each new file (tool prompts).
    const runId = await send(app, runs, id, [
      { name: "plan.md", scope: "session" },
      { name: "style", scope: "global" },
    ]);
    const prompts = store
      .listMessages(id)
      .flatMap((m) => (m.message.role === "tool" ? [m.message.prompt] : []));
    expect(prompts).toEqual([
      {
        title: "Save a new file",
        answers: [
          { question: "Name", answer: "plan.md" },
          { question: "Save to", answer: "session (suggested)" },
        ],
      },
      {
        title: "Save a new file",
        answers: [
          { question: "Name", answer: "style" },
          { question: "Save to", answer: "global (suggested)" },
        ],
      },
    ]);

    const first = model.requests[0] as ChatRequest;
    expect(first.messages[0]).toEqual({
      role: "system",
      content: filesInstruction(true),
    });

    const session = await api(app, "GET", `/api/sessions/${id}/files/plan.md`);
    expect(session.body).toMatchObject({
      value: "# Plan",
      mediaType: "text/markdown",
    });
    expect(session.body.versions).toMatchObject([
      { seq: 1, by: "model", sessionId: id, runId },
    ]);

    const global = await api(app, "GET", "/api/global/files/style");
    expect(global.body.versions).toMatchObject([
      { by: "model", sessionId: id, runId },
    ]);

    // The system message is not stored in the transcript.
    const detail = await api(app, "GET", `/api/sessions/${id}`);
    expect(
      detail.body.messages.some(
        (m: { message: Message }) => m.message.role === "system",
      ),
    ).toBe(false);
  });

  it("says the conversation is not in a project for a standalone session", async () => {
    const { app, runs, model } = await setup([
      [
        { type: "text", text: "Hi" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    await send(app, runs, id);
    expect((model.requests[0] as ChatRequest).messages[0]).toEqual({
      role: "system",
      content: filesInstruction(false),
    });
  });
});

describe("session files", () => {
  it("records the user's edits as edit messages the next run sees", async () => {
    const { app, runs, model, store } = await setup([
      [
        call("c1", "files_write", {
          scope: "session",
          key: "b",
          mediaType: "text/plain",
          value: "fact",
        }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Ok" },
        { type: "finish", reason: "stop" },
      ],
      [
        call("c2", "files_read", { key: "a" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Read" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    await send(app, runs, id, [{ name: "b", scope: "session" }]);

    const put = await api(app, "PUT", `/api/sessions/${id}/files/a`, {
      mediaType: "text/plain",
      value: "from user",
    });
    expect(put.body).toMatchObject({ value: "from user" });
    expect(put.body.versions).toMatchObject([
      { by: "user", sessionId: null, runId: null },
    ]);
    const patched = await api(app, "PUT", `/api/sessions/${id}/files/b`, {
      mediaType: "text/plain",
      value: "fact, edited",
    });
    expect(patched.body.versions.map((v: { by: string }) => v.by)).toEqual([
      "model",
      "user",
    ]);

    const messages = store.listMessages(id).map((m) => m.message);
    expect(messages.filter((m) => m.role === "edit")).toEqual([
      {
        role: "edit",
        content: "[The user changed session file a in the app.]",
        files: [
          {
            op: "put",
            key: "a",
            value: "from user",
            mediaType: "text/plain",
          },
        ],
      },
      {
        role: "edit",
        content: "[The user changed session file b in the app.]",
        files: [
          {
            op: "put",
            key: "b",
            value: "fact, edited",
            mediaType: "text/plain",
          },
        ],
      },
    ]);
    const events = store.eventsAfter(id, 0);
    expect(
      events.filter((e) => e.type === "session.files_changed"),
    ).toHaveLength(2);

    await send(app, runs, id);
    const third = model.requests[2] as ChatRequest;
    expect(third.messages.filter((m) => m.role === "edit")).toHaveLength(2);
    const read = store
      .listMessages(id)
      .map((m) => m.message)
      .filter((m) => m.role === "tool")
      .at(-1);
    expect(read?.content).toContain("from user");
  });

  it("refuses edits while a run is in progress", async () => {
    let release = () => {};
    const { app, runs } = await setup([
      [
        { type: "text", text: "a" },
        { type: "wait", until: new Promise<void>((r) => (release = r)) },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    const run = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "Hi",
    });
    expect(
      (
        await api(app, "PUT", `/api/sessions/${id}/files/a`, {
          mediaType: "text/plain",
          value: "x",
        })
      ).status,
    ).toBe(409);
    release();
    await expect.poll(() => runs.isActive(run.body.runId)).toBe(false);
    expect(
      (
        await api(app, "PUT", `/api/sessions/${id}/files/a`, {
          mediaType: "text/plain",
          value: "x",
        })
      ).status,
    ).toBe(200);
  });

  it("deletes and restores a session file", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    await api(app, "PUT", `/api/sessions/${id}/files/a`, {
      mediaType: "text/plain",
      value: "one",
    });
    expect(
      (await api(app, "DELETE", `/api/sessions/${id}/files/a`)).status,
    ).toBe(204);
    expect(
      (await api(app, "DELETE", `/api/sessions/${id}/files/a`)).status,
    ).toBe(404);
    expect((await api(app, "GET", `/api/sessions/${id}/files`)).body).toEqual(
      [],
    );
    const restored = await api(
      app,
      "POST",
      `/api/sessions/${id}/files/a/restore`,
      { seq: 1 },
    );
    expect(restored.body).toMatchObject({ value: "one", deleted: false });
    expect(restored.body.versions).toHaveLength(3);
  });
});

describe("purge", () => {
  it("keeps project and global versions a purged session made, unlinked", async () => {
    const { app, runs, t } = await setup([
      [
        call("c1", "files_write", {
          scope: "global",
          key: "g",
          mediaType: "text/plain",
          value: "x",
        }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    await send(app, runs, id, [{ name: "g", scope: "global" }]);
    await api(app, "POST", `/api/sessions/${id}/trash`);
    expect((await api(app, "DELETE", `/api/sessions/${id}`)).status).toBe(200);
    const g = await api(app, "GET", "/api/global/files/g");
    expect(g.body.versions).toMatchObject([
      { by: "model", sessionId: null, runId: null },
    ]);
    expect(
      t.db.prepare("SELECT count(*) AS n FROM file_versions").get(),
    ).toEqual({ n: 1 });
  });

  it("deletes a purged project's files and versions", async () => {
    const { app, t } = await setup();
    const p = await newProject(app);
    await api(app, "PUT", `/api/projects/${p}/files/a`, {
      mediaType: "text/plain",
      value: "x",
    });
    await api(app, "PUT", "/api/global/files/a", {
      mediaType: "text/plain",
      value: "g",
    });
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect((await api(app, "DELETE", `/api/projects/${p}`)).status).toBe(200);
    const count = (table: string) =>
      (
        t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count("files")).toBe(1);
    expect(count("file_versions")).toBe(1);
  });
});

describe("files with folders in their names (files unification design, D6, D37)", () => {
  it("saves, reads and deletes a file whose name has folders, spaces and Unicode", async () => {
    const { app } = await setup();
    const key = encodeURIComponent("chars/My Alice é.md");
    const put = await api(app, "PUT", `/api/global/files/${key}`, {
      mediaType: "text/markdown",
      value: "A",
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      key: "chars/My Alice é.md",
      mediaType: "text/markdown",
    });
    expect((await api(app, "GET", `/api/global/files/${key}`)).status).toBe(
      200,
    );
    expect(
      (await api(app, "GET", "/api/global/files")).body.map(
        (f: { key: string }) => f.key,
      ),
    ).toEqual(["chars/My Alice é.md"]);
    expect((await api(app, "DELETE", `/api/global/files/${key}`)).status).toBe(
      204,
    );
  });

  it("refuses a name that breaks the rules", async () => {
    const { app } = await setup();
    for (const bad of ["a..", "a/../b", "NUL.txt", "a%20", "x//y"]) {
      const res = await api(
        app,
        "PUT",
        `/api/global/files/${encodeURIComponent(decodeURIComponent(bad))}`,
        { mediaType: "text/plain", value: "" },
      );
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("folders", () => {
  it("creates, lists, renames and deletes global folders with their files", async () => {
    const { app, files } = await setup();
    expect(
      (await api(app, "POST", "/api/global/folders", { path: "empty" })).status,
    ).toBe(201);
    expect(
      (await api(app, "POST", "/api/global/folders", { path: "empty" })).status,
    ).toBe(200);
    await api(
      app,
      "PUT",
      `/api/global/files/${encodeURIComponent("docs/a.md")}`,
      { mediaType: "text/markdown", value: "A" },
    );
    expect((await api(app, "GET", "/api/global/folders")).body).toEqual([
      "docs",
      "empty",
    ]);

    const renamed = await api(app, "POST", "/api/global/folders/rename", {
      path: "docs",
      newPath: "papers",
    });
    expect(renamed).toMatchObject({ status: 200, body: { path: "papers" } });
    expect(files.get(null, "papers/a.md")).toMatchObject({
      value: "A",
      media_type: "text/markdown",
      deleted_at: null,
    });
    // The old name is deleted, its history kept.
    expect(files.get(null, "docs/a.md")?.deleted_at).not.toBeNull();

    expect(
      (await api(app, "POST", "/api/global/folders/delete", { path: "papers" }))
        .status,
    ).toBe(204);
    expect((await api(app, "GET", "/api/global/files")).body).toEqual([]);
    expect(files.get(null, "papers/a.md")?.deleted_at).not.toBeNull();
    expect((await api(app, "GET", "/api/global/folders")).body).toEqual([
      "empty",
    ]);
  });

  it("answers 404 for a missing folder and 400 for a bad or clashing name", async () => {
    const { app } = await setup();
    expect(
      (
        await api(app, "POST", "/api/global/folders/rename", {
          path: "nope",
          newPath: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(app, "POST", "/api/global/folders/delete", { path: "nope" }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, "POST", "/api/global/folders", { path: "a/../b" }))
        .status,
    ).toBe(400);
    await api(app, "POST", "/api/global/folders", { path: "a" });
    await api(app, "POST", "/api/global/folders", { path: "b" });
    expect(
      (
        await api(app, "POST", "/api/global/folders/rename", {
          path: "a",
          newPath: "b",
        })
      ).status,
    ).toBe(400);
  });

  it("keeps a project's folders apart from global ones, and purging the project removes them", async () => {
    const { app, t } = await setup();
    const p = await newProject(app);
    await api(app, "POST", `/api/projects/${p}/folders`, { path: "mine" });
    await api(app, "POST", "/api/global/folders", { path: "shared" });
    expect((await api(app, "GET", `/api/projects/${p}/folders`)).body).toEqual([
      "mine",
    ]);
    expect((await api(app, "GET", "/api/global/folders")).body).toEqual([
      "shared",
    ]);
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect((await api(app, "DELETE", `/api/projects/${p}`)).status).toBe(200);
    expect(t.db.prepare("SELECT path FROM folders").all()).toEqual([
      { path: "shared" },
    ]);
  });

  it("keeps a session's folders in the transcript as edit messages", async () => {
    const { app, store } = await setup();
    const id = await newSession(app);
    await api(app, "POST", `/api/sessions/${id}/folders`, { path: "drafts" });
    await api(
      app,
      "PUT",
      `/api/sessions/${id}/files/${encodeURIComponent("drafts/one.md")}`,
      { mediaType: "text/markdown", value: "1" },
    );
    expect((await api(app, "GET", `/api/sessions/${id}/folders`)).body).toEqual(
      ["drafts"],
    );
    await api(app, "POST", `/api/sessions/${id}/folders/rename`, {
      path: "drafts",
      newPath: "final",
    });
    expect(
      (await api(app, "GET", `/api/sessions/${id}/files`)).body.map(
        (f: { key: string }) => f.key,
      ),
    ).toEqual(["final/one.md"]);
    expect((await api(app, "GET", `/api/sessions/${id}/folders`)).body).toEqual(
      ["final"],
    );
    const edits = store
      .listMessages(id)
      .filter((m) => m.message.role === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(3);
    await api(app, "POST", `/api/sessions/${id}/folders/delete`, {
      path: "final",
    });
    expect((await api(app, "GET", `/api/sessions/${id}/files`)).body).toEqual(
      [],
    );
    expect((await api(app, "GET", `/api/sessions/${id}/folders`)).body).toEqual(
      [],
    );
  });

  it("lets the model create a folder and list it", async () => {
    const { app, runs } = await setup([
      [
        call("c1", "files_folder_create", { path: "chars", scope: "global" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    await send(app, runs, id, [{ scope: "global" }]);
    expect((await api(app, "GET", "/api/global/folders")).body).toEqual([
      "chars",
    ]);
  });
});
