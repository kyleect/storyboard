import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
} from "@harness/core";
import { AgentStore } from "./agents-store.js";
import { putBlob } from "./blobs.js";
import { EntryStore } from "./entries-store.js";
import {
  DERIVED_INDEX_CHARS,
  getDerived,
  MEDIA_DESCRIBER,
  MediaDescriber,
} from "./media-describer.js";
import { RunManager } from "./runs.js";
import { SearchIndex } from "./search-index.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Derived text and the Media Describer. */

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d49484453", "hex");
const say = (text: string): ScriptStep[] => [
  { type: "text", text },
  { type: "finish", reason: "stop" },
];

async function setup(
  scripts: ScriptStep[][],
  settings: Record<string, unknown> = { mediaDescriberModel: "gemma" },
  timeoutMs?: number,
) {
  const t = tempDatabase();
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  const index = new SearchIndex(t.db);
  const entries = new EntryStore(t.db, undefined, undefined, index);
  const agents = new AgentStore(t.db);
  const model = new ScriptedModel(scripts);
  const current = () => readSettings(t.db, {}).effective;
  const describer = new MediaDescriber({
    db: t.db,
    settings: current,
    agents,
    model: () => model,
    index,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const runs = new RunManager({
    store,
    settings: () => ({ ...current(), autoRename: false }),
    model: () => new ScriptedModel([]),
    entries,
    describer,
    index,
  });
  const app = buildServer({
    store,
    runs,
    entries,
    agents,
    describer,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, agents, model, describer, app, entries, index };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: auth,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (res.body ? res.json() : undefined) as any,
  };
}

const upload = (
  app: FastifyInstance,
  base: string,
  name: string,
  bytes = PNG,
) =>
  app.inject({
    method: "POST",
    url: `${base}/files?name=${encodeURIComponent(name)}`,
    headers: { ...auth, "content-type": "image/png" },
    payload: bytes,
  });

const hashOf = async (app: FastifyInstance, base: string, name: string) =>
  (await api(app, "GET", `${base}/files/${encodeURIComponent(name)}`)).body.blob
    .hash as string;

describe("the built-in Media Describer", () => {
  it("is inserted by the migration, read-only and startable, with no tools", async () => {
    const { agents } = await setup([]);
    const agent = agents.get(MEDIA_DESCRIBER);
    expect(agent).toMatchObject({
      name: "Media Describer",
      builtin: true,
      subagent: true,
      toolGrant: { mode: "allow", groups: [], extras: [] },
    });
    expect(agent?.prompt).toContain("Do not guess at names");
    expect(() =>
      agents.update(MEDIA_DESCRIBER, {
        name: "x",
        description: "",
        prompt: "x",
        toolGrant: agent?.toolGrant as never,
        toolApproval: {},
        childReminders: null,
        childPrompt: null,
        subagent: true,
      }),
    ).toThrow(/built-in/);
  });
});

describe("generation at upload", () => {
  it("writes the text with the agent's prompt, the model chosen and the file", async () => {
    const { app, model, describer, t } = await setup([say("  A grey cat.  ")]);
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "cat.png");
    const hash = await hashOf(app, base, "cat.png");
    await describer.idle();

    expect(getDerived(t.db, hash)).toEqual({
      text: "A grey cat.",
      state: "generated",
    });
    const request = model.requests[0] as ChatRequest;
    expect(request.model).toBe("gemma");
    expect(request.messages[0]).toMatchObject({ role: "system" });
    expect((request.messages[0] as { content: string }).content).toContain(
      "You describe one image or audio file",
    );
    expect(request.messages[1]).toMatchObject({ role: "user", content: "" });
    const ref = (request.messages[1] as { files: string[] }).files[0] as string;
    expect(request.resolveFile?.(ref)).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(
      (await api(app, "GET", `/api/blobs/${hash}/derived-text`)).body,
    ).toEqual({ text: "A grey cat.", state: "generated" });
  });

  it("is off with no model: nothing runs and the state stays none", async () => {
    const { app, model, describer, t } = await setup([say("x")], {});
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "cat.png");
    const hash = await hashOf(app, base, "cat.png");
    await describer.idle();
    expect(model.requests).toHaveLength(0);
    expect(getDerived(t.db, hash)?.state).toBe("none");
    expect(describer.enabled()).toBe(false);
    expect((await api(app, "POST", `/api/blobs/${hash}/describe`)).status).toBe(
      409,
    );
    expect(
      (
        await api(app, "POST", "/api/media-describer/regenerate", {
          mode: "all",
        })
      ).status,
    ).toBe(409);
  });

  it("is off when the agent setting is cleared", async () => {
    const { describer } = await setup([], {
      mediaDescriberModel: "gemma",
      mediaDescriberAgent: "",
    });
    expect(describer.enabled()).toBe(false);
  });

  it("marks a failure, keeps the field empty, and Retry writes it", async () => {
    const { app, describer, t } = await setup([
      [{ type: "throw", message: "model unreachable" }],
      say("A grey cat."),
    ]);
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "cat.png");
    const hash = await hashOf(app, base, "cat.png");
    await describer.idle();
    expect(getDerived(t.db, hash)).toEqual({ text: "", state: "failed" });

    const retry = await api(app, "POST", `/api/blobs/${hash}/describe`);
    expect(retry.status).toBe(202);
    expect(retry.body.state).toBe("pending");
    await describer.idle();
    expect(getDerived(t.db, hash)).toEqual({
      text: "A grey cat.",
      state: "generated",
    });
  });

  it("counts an empty reply as a failure", async () => {
    const { app, describer, t } = await setup([say("   ")]);
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    await upload(app, `/api/sessions/${id}`, "cat.png");
    await describer.idle();
    const hash = await hashOf(app, `/api/sessions/${id}`, "cat.png");
    expect(getDerived(t.db, hash)?.state).toBe("failed");
  });

  it("times out after the limit and does not retry by itself", async () => {
    const never = new Promise(() => {});
    const { app, describer, t, model } = await setup(
      [[{ type: "wait", until: never }]],
      { mediaDescriberModel: "gemma" },
      20,
    );
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    await upload(app, `/api/sessions/${id}`, "cat.png");
    await describer.idle();
    const hash = await hashOf(app, `/api/sessions/${id}`, "cat.png");
    expect(getDerived(t.db, hash)).toEqual({ text: "", state: "failed" });
    expect(model.requests).toHaveLength(1);
  });

  it("does not write over text that is already there when the same bytes come again", async () => {
    const { app, describer, model } = await setup([say("A cat.")]);
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "one.png");
    await describer.idle();
    await upload(app, base, "two.png");
    await describer.idle();
    expect(model.requests).toHaveLength(1);
  });

  it("marks a generation the backend stopped in as failed when it starts again", async () => {
    const { describer, t } = await setup([]);
    const hash = putBlob(t.db, "image/png", PNG, "now").hash;
    t.db
      .prepare("UPDATE blobs SET derived_state = 'pending' WHERE hash = ?")
      .run(hash);
    expect(describer.recover()).toBe(1);
    expect(getDerived(t.db, hash)?.state).toBe("failed");
  });
});

describe("editing and regenerating", () => {
  it("keeps the user's text, and an empty text clears it", async () => {
    const { app, t } = await setup([], {});
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "cat.png");
    const hash = await hashOf(app, base, "cat.png");
    const url = `/api/blobs/${hash}/derived-text`;
    expect((await api(app, "PUT", url, { text: "My cat" })).body).toEqual({
      text: "My cat",
      state: "edited",
    });
    expect((await api(app, "PUT", url, { text: "" })).body).toEqual({
      text: "",
      state: "none",
    });
    expect(getDerived(t.db, hash)?.state).toBe("none");
    expect(
      (await api(app, "PUT", "/api/blobs/nope/derived-text", { text: "x" }))
        .status,
    ).toBe(404);
    expect((await api(app, "GET", "/api/blobs/nope/derived-text")).status).toBe(
      404,
    );
  });

  it("asks first: counts files, then fills the empty ones or all but edited text", async () => {
    const { app, describer, t, model } = await setup(
      [say("one"), say("two"), say("three")],
      {},
    );
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "a.png", PNG);
    await upload(app, base, "b.png", PNG2);
    const a = await hashOf(app, base, "a.png");
    const b = await hashOf(app, base, "b.png");
    await api(app, "PUT", `/api/blobs/${a}/derived-text`, { text: "mine" });

    // Generation is off while the model is empty: nothing to ask.
    expect((await api(app, "GET", "/api/media-describer")).body).toEqual({
      enabled: false,
      files: 2,
      empty: 1,
    });

    // Setting a model changes nothing by itself.
    writeSettings(t.db, { mediaDescriberModel: "gemma" });
    expect((await api(app, "GET", "/api/media-describer")).body).toEqual({
      enabled: true,
      files: 2,
      empty: 1,
    });
    await describer.idle();
    expect(model.requests).toHaveLength(0);

    // Empty only: b is written, a keeps the user's text.
    expect(
      (
        await api(app, "POST", "/api/media-describer/regenerate", {
          mode: "empty",
        })
      ).body,
    ).toEqual({ queued: 1 });
    await describer.idle();
    expect(getDerived(t.db, b)).toEqual({ text: "one", state: "generated" });
    expect(getDerived(t.db, a)).toEqual({ text: "mine", state: "edited" });

    // All: b is written again; a is the user's and stays.
    expect(
      (
        await api(app, "POST", "/api/media-describer/regenerate", {
          mode: "all",
        })
      ).body,
    ).toEqual({ queued: 1 });
    await describer.idle();
    expect(getDerived(t.db, b)).toEqual({ text: "two", state: "generated" });
    expect(getDerived(t.db, a)?.text).toBe("mine");
  });

  it("keeps the old text when a retry fails", async () => {
    const { app, describer, t } = await setup([
      say("first"),
      [{ type: "throw", message: "down" }],
    ]);
    const id = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const base = `/api/sessions/${id}`;
    await upload(app, base, "cat.png");
    await describer.idle();
    const hash = await hashOf(app, base, "cat.png");
    await api(app, "POST", `/api/blobs/${hash}/describe`);
    await describer.idle();
    expect(getDerived(t.db, hash)).toEqual({ text: "first", state: "failed" });
  });
});

describe("search through derived text", () => {
  const chunks = (
    db: import("better-sqlite3-multiple-ciphers").Database,
    key: string,
  ) =>
    (
      db
        .prepare("SELECT text FROM chunks WHERE key = ? ORDER BY seq")
        .all(key) as { text: string }[]
    ).map((c) => c.text);

  it("indexes session, project and global files by their text and drops it when cleared", async () => {
    const { app, t, describer } = await setup([], {});
    const sid = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    const pid = (await api(app, "POST", "/api/projects", { name: "P" })).body
      .id as string;
    await upload(app, `/api/sessions/${sid}`, "cat.png");
    await upload(app, `/api/projects/${pid}`, "dog.png", PNG);
    const hash = await hashOf(app, `/api/sessions/${sid}`, "cat.png");
    expect(chunks(t.db, "cat.png")).toEqual([]);

    describer.setText(hash, "A grey cat on a windowsill");
    expect(chunks(t.db, "cat.png")).toEqual(["A grey cat on a windowsill"]);
    // The same bytes in a project file are found by it too.
    expect(chunks(t.db, "dog.png")).toEqual(["A grey cat on a windowsill"]);

    describer.setText(hash, "");
    expect(chunks(t.db, "cat.png")).toEqual([]);
    expect(chunks(t.db, "dog.png")).toEqual([]);
  });

  it("indexes only the start of a long text, and keeps all of it", async () => {
    const { app, t, describer } = await setup([], {});
    const sid = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    await upload(app, `/api/sessions/${sid}`, "cat.png");
    const hash = await hashOf(app, `/api/sessions/${sid}`, "cat.png");
    const long = "word ".repeat(2000).trim();
    describer.setText(hash, long);
    expect(getDerived(t.db, hash)?.text).toBe(long);
    const indexed = chunks(t.db, "cat.png").join(" ");
    expect(indexed.length).toBeLessThanOrEqual(DERIVED_INDEX_CHARS);
    expect(indexed.length).toBeGreaterThan(DERIVED_INDEX_CHARS / 2);
  });

  it("indexes a new file whose bytes already have text", async () => {
    const { app, t, describer } = await setup([], {});
    const sid = (await api(app, "POST", "/api/sessions", { title: "T" })).body
      .id as string;
    await upload(app, `/api/sessions/${sid}`, "cat.png");
    describer.setText(
      await hashOf(app, `/api/sessions/${sid}`, "cat.png"),
      "A cat",
    );
    await upload(app, `/api/sessions/${sid}`, "again.png");
    expect(chunks(t.db, "again.png")).toEqual(["A cat"]);
  });
});
