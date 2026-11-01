import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type Message,
  type ScriptStep,
} from "@harness/core";
import { allTools, entriesInstruction } from "@harness/tools";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Files and memory (files and memory design): routes, tools, purge. */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(scripts: ScriptStep[][] = []) {
  const t = tempDatabase();
  const store = new Store(t.db);
  let clock = 0;
  const now = () => `2026-11-01T00:00:${String(++clock).padStart(2, "0")}Z`;
  const entries = new EntryStore(t.db, now);
  const model = new ScriptedModel(scripts);
  let note = 0;
  const runs = new RunManager({
    store,
    settings: () => readSettings(t.db, {}).effective,
    model: () => model,
    tools: allTools,
    entries,
    systemPrompt: (s) => entriesInstruction(s.project_id !== null),
    newNoteId: () => `n${++note}`,
    now,
  });
  const app = buildServer({ store, runs, entries, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, entries };
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

async function send(app: FastifyInstance, runs: RunManager, id: string) {
  const run = await api(app, "POST", `/api/sessions/${id}/messages`, {
    content: "Go",
  });
  expect(run.status).toBe(202);
  await expect.poll(() => runs.isActive(run.body.runId)).toBe(false);
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
        type: "markdown",
        value,
      });
    expect((await put("v1")).status).toBe(200);
    const second = await put("v2");
    expect(second.body).toMatchObject({
      key: "style.md",
      type: "markdown",
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
        await api(app, "PUT", "/api/global/files/a:b", {
          type: "plain",
          value: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, "PUT", "/api/global/files/a", {
          type: "json",
          value: "{",
        })
      ).status,
    ).toBe(400);
    expect((await api(app, "GET", "/api/global/files/none")).status).toBe(404);
    expect((await api(app, "DELETE", "/api/global/files/none")).status).toBe(
      404,
    );
    await api(app, "PUT", "/api/global/files/a", { type: "plain", value: "x" });
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
      type: "plain",
      value: "project",
    });
    await api(app, "PUT", "/api/global/files/a", {
      type: "plain",
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
          type: "plain",
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
    const { app, runs, model } = await setup([
      [
        call("c1", "files_write", {
          scope: "session",
          key: "plan.md",
          type: "markdown",
          value: "# Plan",
        }),
        call("c2", "files_write", {
          scope: "global",
          key: "style",
          type: "plain",
          value: "terse",
        }),
        call("c3", "memory_add", {
          scope: "project",
          text: "Alice fears water",
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
    const runId = await send(app, runs, id);

    const first = model.requests[0] as ChatRequest;
    expect(first.messages[0]).toEqual({
      role: "system",
      content: entriesInstruction(true),
    });

    const session = await api(app, "GET", `/api/sessions/${id}/files/plan.md`);
    expect(session.body).toMatchObject({ value: "# Plan", type: "markdown" });
    expect(session.body.versions).toMatchObject([
      { seq: 1, by: "model", sessionId: id, runId },
    ]);

    const global = await api(app, "GET", "/api/global/files/style");
    expect(global.body.versions).toMatchObject([
      { by: "model", sessionId: id, runId },
    ]);

    const notes = await api(app, "GET", `/api/projects/${p}/notes`);
    expect(notes.body).toMatchObject([
      { key: "n1", value: "Alice fears water" },
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
      content: entriesInstruction(false),
    });
  });
});

describe("session files and notes", () => {
  it("records the user's edits as edit messages the next run sees", async () => {
    const { app, runs, model, store } = await setup([
      [
        call("c1", "memory_add", { scope: "session", text: "fact" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Ok" },
        { type: "finish", reason: "stop" },
      ],
      [
        call("c2", "files_read", { scope: "session", key: "a" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Read" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const id = await newSession(app);
    await send(app, runs, id);

    const put = await api(app, "PUT", `/api/sessions/${id}/files/a`, {
      type: "plain",
      value: "from user",
    });
    expect(put.body).toMatchObject({ value: "from user" });
    expect(put.body.versions).toMatchObject([
      { by: "user", sessionId: null, runId: null },
    ]);
    const patched = await api(app, "PATCH", `/api/sessions/${id}/notes/n1`, {
      text: "fact, edited",
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
        entries: [
          {
            op: "put",
            kind: "file",
            key: "a",
            value: "from user",
            type: "plain",
          },
        ],
      },
      {
        role: "edit",
        content: "[The user changed session memory note n1 in the app.]",
        entries: [
          { op: "put", kind: "note", key: "n1", value: "fact, edited" },
        ],
      },
    ]);
    const events = store.eventsAfter(id, 0);
    expect(
      events.filter((e) => e.type === "session.entries_changed"),
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
          type: "plain",
          value: "x",
        })
      ).status,
    ).toBe(409);
    release();
    await expect.poll(() => runs.isActive(run.body.runId)).toBe(false);
    expect(
      (
        await api(app, "PUT", `/api/sessions/${id}/files/a`, {
          type: "plain",
          value: "x",
        })
      ).status,
    ).toBe(200);
  });

  it("deletes and restores a session file", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    await api(app, "PUT", `/api/sessions/${id}/files/a`, {
      type: "plain",
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
          type: "plain",
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
    await send(app, runs, id);
    await api(app, "POST", `/api/sessions/${id}/trash`);
    expect((await api(app, "DELETE", `/api/sessions/${id}`)).status).toBe(200);
    const g = await api(app, "GET", "/api/global/files/g");
    expect(g.body.versions).toMatchObject([
      { by: "model", sessionId: null, runId: null },
    ]);
    expect(
      t.db.prepare("SELECT count(*) AS n FROM entry_versions").get(),
    ).toEqual({ n: 1 });
  });

  it("deletes a purged project's entries and versions", async () => {
    const { app, t } = await setup();
    const p = await newProject(app);
    await api(app, "PUT", `/api/projects/${p}/files/a`, {
      type: "plain",
      value: "x",
    });
    await api(app, "PUT", "/api/global/files/a", { type: "plain", value: "g" });
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect((await api(app, "DELETE", `/api/projects/${p}`)).status).toBe(200);
    const count = (table: string) =>
      (
        t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count("entries")).toBe(1);
    expect(count("entry_versions")).toBe(1);
  });
});
