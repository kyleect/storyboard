import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type ToolContext,
} from "@harness/core";
import { allTools } from "@harness/tools";
import { getBlob, putBlob } from "./blobs.js";
import { resultText, saveMedia } from "./mcp-manager.js";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { runAnsweringForms, tempDatabase } from "./test-helpers.js";

/* Media in requests: the policy, the keep choices, files_read media, MCP media. */

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const stop: ScriptStep[] = [
  { type: "text", text: "ok" },
  { type: "finish", reason: "stop" },
];
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function setup(
  scripts: ScriptStep[][] = [stop],
  settings: Record<string, unknown> = {},
  support?: { image: boolean; audio: boolean },
) {
  const t = tempDatabase();
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  const entries = new EntryStore(t.db);
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
    ...(support ? { mediaSupport: () => Promise.resolve(support) } : {}),
  });
  const app = buildServer({
    store,
    runs,
    entries,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model };
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

const newSession = async (app: FastifyInstance) =>
  (await api(app, "POST", "/api/sessions", { title: "T" })).body.id as string;

const upload = (app: FastifyInstance, id: string, name: string) =>
  app.inject({
    method: "POST",
    url: `/api/sessions/${id}/files?name=${encodeURIComponent(name)}`,
    headers: { ...auth, "content-type": "image/png" },
    payload: PNG,
  });

describe("the media policy of a run", () => {
  it("carries the settings, the model's support, the user's choices and file info", async () => {
    const { app, runs, model } = await setup(
      [stop],
      { inlineMediaCap: 2, keepMediaInline: true },
      { image: true, audio: false },
    );
    const id = await newSession(app);
    await upload(app, id, "cat.png");
    await api(app, "PUT", `/api/sessions/${id}/media-choices`, {
      ref: "session://cat.png",
      keep: false,
    });
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "look",
      files: ["session://cat.png"],
    });
    await runAnsweringForms(runs, id, res.body.runId, []);
    const media = (model.requests[0] as ChatRequest).media;
    expect(media).toMatchObject({
      cap: 2,
      keepDefault: true,
      support: { image: true, audio: false },
    });
    expect(media?.choices?.get("session://cat.png")).toBe(false);
    expect(media?.choices?.get("session://other.png")).toBeUndefined();
    expect(media?.info("session://cat.png")).toEqual({
      mediaType: "image/png",
    });
    expect(media?.info("session://gone.png")).toBeUndefined();
  });

  it("gives a file's derived text in its info", async () => {
    const { app, runs, model, t } = await setup();
    const id = await newSession(app);
    await upload(app, id, "cat.png");
    t.db.prepare("UPDATE blobs SET derived_text = 'A cat'").run();
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "hi",
    });
    await runAnsweringForms(runs, id, res.body.runId, []);
    const media = (model.requests[0] as ChatRequest).media;
    expect(media?.info("session://cat.png")).toEqual({
      mediaType: "image/png",
      derivedText: "A cat",
    });
  });

  it("is built without support when the model's modalities are not known", async () => {
    const { app, runs, model } = await setup();
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "hi",
    });
    await runAnsweringForms(runs, id, res.body.runId, []);
    const media = (model.requests[0] as ChatRequest).media;
    expect(media?.cap).toBe(4);
    expect(media?.support).toBeUndefined();
  });

  it("records the media files_read returns on its tool message", async () => {
    const { app, runs, store } = await setup([
      [
        {
          type: "tool_call",
          callId: "c1",
          name: "files_read",
          arguments: JSON.stringify({ key: "session://cat.png", keep: true }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
      stop,
    ]);
    const id = await newSession(app);
    await upload(app, id, "cat.png");
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "read it",
    });
    await runAnsweringForms(runs, id, res.body.runId, []);
    const tool = store.listMessages(id).find((m) => m.message.role === "tool");
    expect(tool?.message).toMatchObject({
      role: "tool",
      name: "files_read",
      isError: false,
      media: [{ ref: "session://cat.png", keep: true }],
    });
  });
});

describe("the keep choices", () => {
  it("sets, lists and clears a choice", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    await upload(app, id, "cat.png");
    const url = `/api/sessions/${id}/media-choices`;
    expect((await api(app, "GET", url)).body).toEqual([]);
    await api(app, "PUT", url, { ref: "session://cat.png", keep: true });
    expect((await api(app, "GET", url)).body).toEqual([
      { ref: "session://cat.png", keep: true },
    ]);
    await api(app, "PUT", url, { ref: "session://cat.png", keep: false });
    expect((await api(app, "GET", url)).body).toEqual([
      { ref: "session://cat.png", keep: false },
    ]);
    await api(app, "PUT", url, { ref: "session://cat.png", keep: null });
    expect((await api(app, "GET", url)).body).toEqual([]);
  });

  it("refuses an unknown session and a file that is not media", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    await api(app, "PUT", `/api/sessions/${id}/files/notes.md`, {
      mediaType: "text/markdown",
      value: "hi",
    });
    expect(
      (
        await api(app, "PUT", "/api/sessions/nope/media-choices", {
          ref: "session://a.png",
          keep: true,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(app, "GET", "/api/sessions/nope/media-choices")).status,
    ).toBe(404);
    for (const ref of ["session://notes.md", "session://gone.png"]) {
      expect(
        (
          await api(app, "PUT", `/api/sessions/${id}/media-choices`, {
            ref,
            keep: true,
          })
        ).status,
      ).toBe(400);
    }
  });

  it("goes with the session when it is purged", async () => {
    const { app, store, t } = await setup();
    const id = await newSession(app);
    await upload(app, id, "cat.png");
    await api(app, "PUT", `/api/sessions/${id}/media-choices`, {
      ref: "session://cat.png",
      keep: true,
    });
    store.purgeSession(id);
    expect(
      t.db.prepare("SELECT count(*) AS n FROM media_choices").get(),
    ).toEqual({ n: 0 });
  });
});

describe("MCP images and audio", () => {
  const png64 = PNG.toString("base64");

  function context() {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const ctx = {
      blobs: {
        put: (mediaType: string, data: Uint8Array) =>
          putBlob(t.db, mediaType, Buffer.from(data), "now"),
      },
      entries: createEntryAccess({
        session: replaySessionEntries([]),
        sessionOps: [],
        inProject: false,
        author: { by: "model", sessionId: "s", runId: "r" },
      }),
    } as unknown as ToolContext;
    return { ctx, t };
  }

  it("saves an image as a session file and names it in the text", () => {
    const { ctx, t } = context();
    const media: string[] = [];
    const text = resultText(
      { content: [{ type: "image", data: png64, mimeType: "image/png" }] },
      (mime, data) => {
        const ref = saveMedia(ctx, "mcp_shots_grab", mime, data);
        if (ref) media.push(ref);
        return ref;
      },
    );
    expect(media).toEqual(["session://mcp_shots_grab-1.png"]);
    expect(text).toBe("[image saved as <session://mcp_shots_grab-1.png>]");
    const file = ctx.entries.readFile("session", "mcp_shots_grab-1.png");
    expect(file?.mediaType).toBe("image/png");
    expect(file?.blob && getBlob(t.db, file.blob.hash)?.data).toEqual(PNG);
  });

  it("numbers a second file from the same tool", () => {
    const { ctx } = context();
    expect(saveMedia(ctx, "mcp_s_t", "image/png", png64)).toBe(
      "session://mcp_s_t-1.png",
    );
    expect(saveMedia(ctx, "mcp_s_t", "image/png", png64)).toBe(
      "session://mcp_s_t-2.png",
    );
  });

  it("leaves out what cannot be saved and says so", () => {
    const { ctx } = context();
    // Bytes that are not the declared type, a type the model server cannot read.
    expect(saveMedia(ctx, "t", "image/png", "AAAA")).toBeUndefined();
    expect(saveMedia(ctx, "t", "image/webp", png64)).toBeUndefined();
    // No blob store in the context.
    expect(
      saveMedia(
        { ...ctx, blobs: undefined } as ToolContext,
        "t",
        "image/png",
        png64,
      ),
    ).toBeUndefined();
    expect(
      resultText({
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    ).toBe("[image omitted: image/png, about 3 bytes]");
  });
});
