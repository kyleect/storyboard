import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
} from "@harness/core";
import { detectAttachment, MAX_ATTACHMENT_BYTES } from "./attachment-types.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const reply: ScriptStep[] = [
  { type: "text", text: "ok" },
  { type: "finish", reason: "stop" },
];

async function setup(scripts: ScriptStep[][] = [reply]) {
  const t = tempDatabase();
  const store = new Store(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
      systemPrompt: "",
    }),
    model: () => model,
  });
  const app = buildServer({ store, runs, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { store, runs, app, model };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
]);
const MP3 = Buffer.from("494433030000000000", "hex");

async function newSession(app: App) {
  const res = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: auth,
    payload: { title: "Test" },
  });
  return (res.json() as { id: string }).id;
}

function upload(
  app: App,
  sessionId: string,
  type: string,
  bytes: Buffer,
  name?: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/attachments${name ? `?name=${encodeURIComponent(name)}` : ""}`,
    headers: { ...auth, "content-type": type },
    payload: bytes,
  });
}

function send(app: App, sessionId: string, body: object) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    headers: auth,
    payload: body,
  });
}

describe("detectAttachment", () => {
  it("accepts a file whose bytes match its media type", () => {
    expect(detectAttachment("image/png", PNG)).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(detectAttachment("image/jpg; charset=x", JPEG)).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
    });
    expect(detectAttachment("audio/x-wav", WAV)).toEqual({
      kind: "audio",
      mediaType: "audio/wav",
    });
    expect(detectAttachment("audio/mp3", MP3)).toEqual({
      kind: "audio",
      mediaType: "audio/mpeg",
    });
    expect(
      detectAttachment("audio/mpeg", Buffer.from([0xff, 0xfb, 0x90, 0x00])),
    ).toMatchObject({ kind: "audio" });
  });

  it("refuses a mismatch and types llama-server cannot read", () => {
    expect(detectAttachment("image/jpeg", PNG)).toBeUndefined();
    expect(detectAttachment("audio/wav", MP3)).toBeUndefined();
    expect(detectAttachment("image/webp", Buffer.from("RIFFxxxxWEBP"))).toBe(
      undefined,
    );
    expect(detectAttachment("text/plain", PNG)).toBeUndefined();
  });
});

describe("uploading", () => {
  it("keeps a file and serves it back", async () => {
    const { app } = await setup();
    const id = await newSession(app);

    const res = await upload(app, id, "image/png", PNG, "cat.png");
    expect(res.statusCode).toBe(201);
    const attachment = res.json() as { id: string };
    expect(attachment).toEqual({
      id: expect.any(String),
      kind: "image",
      mediaType: "image/png",
      name: "cat.png",
      size: PNG.length,
    });

    const got = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachment.id}`,
      headers: auth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.rawPayload.equals(PNG)).toBe(true);
  });

  it("needs the token to read a file", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const { id: fileId } = (await upload(app, id, "image/png", PNG)).json() as {
      id: string;
    };
    const res = await app.inject({
      method: "GET",
      url: `/api/attachments/${fileId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an empty file, a mismatch and a type it cannot read", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    expect(
      (await upload(app, id, "image/png", Buffer.alloc(0))).statusCode,
    ).toBe(400);
    expect((await upload(app, id, "image/jpeg", PNG)).statusCode).toBe(400);
    expect(
      (await upload(app, id, "image/webp", Buffer.from("RIFFxxxxWEBP")))
        .statusCode,
    ).toBe(400);
    const text = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/attachments`,
      headers: { ...auth, "content-type": "text/plain" },
      payload: "hello",
    });
    expect(text.statusCode).toBe(415);
  });

  it("refuses a file over the size limit", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    expect((await upload(app, id, "image/png", big)).statusCode).toBe(413);
  });

  it("refuses a missing session and one in the trash", async () => {
    const { app } = await setup();
    expect((await upload(app, "nope", "image/png", PNG)).statusCode).toBe(404);
    const id = await newSession(app);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/trash`,
      headers: auth,
    });
    expect((await upload(app, id, "image/png", PNG)).statusCode).toBe(409);
  });
});

describe("sending attachments", () => {
  it("stores them with the message and gives the model their bytes", async () => {
    const { app, store, runs, model } = await setup();
    const id = await newSession(app);
    const image = (await upload(app, id, "image/png", PNG, "a.png")).json();
    const audio = (await upload(app, id, "audio/wav", WAV, "b.wav")).json();

    const sent = await send(app, id, {
      content: "What do you see and hear?",
      attachmentIds: [image.id, audio.id, image.id],
    });
    expect(sent.statusCode).toBe(202);
    await expect
      .poll(() => runs.isActive((sent.json() as { runId: string }).runId))
      .toBe(false);

    const stored = store.listMessages(id)[0]?.message;
    expect(stored).toEqual({
      role: "user",
      content: "What do you see and hear?",
      // The repeated id counts once, in the order given.
      attachments: [image, audio],
    });

    const request = model.requests[0] as ChatRequest;
    const user = request.messages.find((m) => m.role === "user");
    const attachments = user?.role === "user" ? (user.attachments ?? []) : [];
    expect(attachments.map((a) => request.resolveAttachment?.(a))).toEqual([
      PNG.toString("base64"),
      WAV.toString("base64"),
    ]);
  });

  it("takes a message of attachments only", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const image = (await upload(app, id, "image/png", PNG)).json();
    const res = await send(app, id, { content: "", attachmentIds: [image.id] });
    expect(res.statusCode).toBe(202);
  });

  it("refuses a message with neither text nor attachments", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    expect((await send(app, id, { content: "" })).statusCode).toBe(400);
    expect(
      (await send(app, id, { content: "", attachmentIds: [] })).statusCode,
    ).toBe(400);
  });

  it("refuses an attachment that was uploaded to another session", async () => {
    const { app } = await setup();
    const a = await newSession(app);
    const b = await newSession(app);
    const image = (await upload(app, a, "image/png", PNG)).json();
    const res = await send(app, b, { content: "x", attachmentIds: [image.id] });
    expect(res.statusCode).toBe(400);
    expect(
      (await send(app, b, { content: "x", attachmentIds: ["nope"] }))
        .statusCode,
    ).toBe(400);
  });

  it("removes a session's files when the session is purged", async () => {
    const { app, store } = await setup();
    const id = await newSession(app);
    const image = (await upload(app, id, "image/png", PNG)).json();
    expect(store.getAttachmentData(image.id)).toBeDefined();
    store.purgeSession(id);
    expect(store.getAttachmentData(image.id)).toBeUndefined();
  });
});
