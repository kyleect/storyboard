import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaySessionEntries,
  ScriptedModel,
  type ChatRequest,
  type EntryOp,
  type ScriptStep,
} from "@harness/core";
import { allTools } from "@harness/tools";
import { getBlob, putBlob, sha256, sweepBlobs } from "./blobs.js";
import {
  attachmentFileName,
  attachmentsToFiles,
  runDataSteps,
} from "./data-steps.js";
import { BINARY_VERSIONS_KEPT, EntryStore } from "./entries-store.js";
import { detectMedia, MAX_UPLOAD_BYTES } from "./media-detect.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { runAnsweringForms, tempDatabase } from "./test-helpers.js";

/* Binary files: media detection, uploads, blobs, versions, the migration of attachments. */

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
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let clock = 0;
  const now = () =>
    new Date(Date.UTC(2026, 10, 7, 14, 32, ++clock))
      .toISOString()
      .replace(".000Z", "Z");
  const entries = new EntryStore(t.db, now);
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
    now,
  });
  const app = buildServer({
    store,
    runs,
    entries,
    token: TOKEN,
    env: {},
    now,
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, entries };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d49484453", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
]);
const MP3 = Buffer.from("494433030000000000", "hex");

function upload(
  app: FastifyInstance,
  base: string,
  type: string,
  bytes: Buffer,
  query = "",
) {
  return app.inject({
    method: "POST",
    url: `${base}/files${query}`,
    headers: { ...auth, "content-type": type },
    payload: bytes,
  });
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
const newProject = async (app: FastifyInstance) =>
  (await api(app, "POST", "/api/projects", { name: "P" })).body.id as string;

const blobCount = (db: { prepare: (s: string) => { get(): unknown } }) =>
  (db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n;

describe("detectMedia", () => {
  it("accepts a file whose bytes match its media type", () => {
    expect(detectMedia("image/png", PNG)).toEqual({
      kind: "image",
      mediaType: "image/png",
      extension: "png",
    });
    expect(detectMedia("image/jpg; charset=x", JPEG)).toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(detectMedia("audio/x-wav", WAV)).toMatchObject({
      kind: "audio",
      mediaType: "audio/wav",
    });
    expect(detectMedia("audio/mp3", MP3)).toMatchObject({
      mediaType: "audio/mpeg",
    });
    expect(
      detectMedia("audio/mpeg", Buffer.from([0xff, 0xfb, 0x90, 0x00])),
    ).toMatchObject({ kind: "audio" });
  });

  it("refuses a mismatch and types llama-server cannot read", () => {
    expect(detectMedia("image/jpeg", PNG)).toBeUndefined();
    expect(detectMedia("audio/wav", MP3)).toBeUndefined();
    expect(
      detectMedia("image/webp", Buffer.from("RIFFxxxxWEBP")),
    ).toBeUndefined();
    expect(detectMedia("text/plain", PNG)).toBeUndefined();
  });
});

describe("uploading", () => {
  it("keeps a session file and serves its bytes by hash", async () => {
    const { app, store } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;

    const res = await upload(app, base, "image/png", PNG, "?name=cat.png");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      key: "cat.png",
      ref: "session://cat.png",
      mediaType: "image/png",
      size: PNG.length,
      blob: { hash: sha256(PNG), size: PNG.length },
      replaced: false,
    });

    const got = await app.inject({
      method: "GET",
      url: `/api/blobs/${sha256(PNG)}`,
      headers: auth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/blobs/${"0".repeat(64)}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);

    // The file is in the transcript as an edit message that names the bytes.
    const state = replaySessionEntries(
      store.listMessages(id).map((m) => m.message),
    );
    expect(state.file.get("cat.png")).toEqual({
      value: "",
      mediaType: "image/png",
      blob: { hash: sha256(PNG), size: PNG.length },
    });
    const list = await api(app, "GET", `${base}/files`);
    expect(list.body).toMatchObject([
      {
        key: "cat.png",
        mediaType: "image/png",
        value: "",
        blob: { size: PNG.length },
      },
    ]);
  });

  it("keeps project and global files in the tables", async () => {
    const { app, entries } = await setup();
    const p = await newProject(app);
    const a = await upload(
      app,
      `/api/projects/${p}`,
      "audio/wav",
      WAV,
      "?name=a/b.wav",
    );
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ ref: "project://a/b.wav" });
    const g = await upload(
      app,
      "/api/global",
      "image/jpeg",
      JPEG,
      "?name=j.jpg",
    );
    expect(g.json()).toMatchObject({ ref: "global://j.jpg" });
    expect(entries.get("file", p, "a/b.wav")).toMatchObject({
      media_type: "audio/wav",
      value: "",
      blob_hash: sha256(WAV),
      size: WAV.length,
    });
    expect(
      (await api(app, "GET", "/api/projects/" + p + "/folders")).body,
    ).toEqual(["a"]);
  });

  it("names an unnamed file and puts a suffix on a name in use", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    const unnamed = await upload(app, base, "audio/wav", WAV);
    expect(unnamed.json().key).toMatch(/^recording-2026-11-07-1432\.wav$/);
    const img = await upload(app, base, "image/png", PNG);
    expect(img.json().key).toBe("image-2026-11-07-1432.png");

    await upload(app, base, "image/png", PNG, "?name=cat.png");
    const second = await upload(app, base, "image/png", PNG2, "?name=cat.png");
    expect(second.json()).toMatchObject({
      key: "cat (2).png",
      replaced: false,
    });
    const third = await upload(app, base, "image/png", PNG2, "?name=cat.png");
    expect(third.json().key).toBe("cat (3).png");
  });

  it("replaces a file only when asked to", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    await upload(app, base, "image/png", PNG, "?name=cat.png");
    const res = await upload(
      app,
      base,
      "image/png",
      PNG2,
      "?name=cat.png&replace=true",
    );
    expect(res.json()).toMatchObject({ key: "cat.png", replaced: true });
    expect(
      (await api(app, "GET", `${base}/files/cat.png`)).body.blob.hash,
    ).toBe(sha256(PNG2));
  });

  it("refuses what is not an image or audio file, with the right status", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    expect(
      (await upload(app, base, "image/png", Buffer.alloc(0))).statusCode,
    ).toBe(400);
    expect((await upload(app, base, "image/jpeg", PNG)).statusCode).toBe(400);
    expect(
      (await upload(app, base, "image/webp", Buffer.from("RIFFxxxxWEBP")))
        .statusCode,
    ).toBe(400);
    const json = await app.inject({
      method: "POST",
      url: `${base}/files`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { a: 1 },
    });
    expect(json.statusCode).toBe(415);
    expect(
      (await upload(app, base, "image/png", PNG, "?name=a/../b.png"))
        .statusCode,
    ).toBe(400);
    expect(
      (await upload(app, base, "image/png", PNG, "?name=NUL.png")).statusCode,
    ).toBe(400);
    expect((await api(app, "GET", `${base}/files`)).body).toEqual([]);
  });

  it("refuses a file over the limit", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(
      (await upload(app, `/api/sessions/${id}`, "image/png", big)).statusCode,
    ).toBe(413);
  });

  it("refuses an upload to a session or project in the trash", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    await api(app, "POST", `/api/sessions/${id}/trash`);
    expect(
      (await upload(app, `/api/sessions/${id}`, "image/png", PNG)).statusCode,
    ).toBe(409);
    const p = await newProject(app);
    await api(app, "POST", `/api/projects/${p}/trash`);
    expect(
      (await upload(app, `/api/projects/${p}`, "image/png", PNG)).statusCode,
    ).toBe(409);
  });

  it("refuses to save a binary media type as text", async () => {
    const { app } = await setup();
    const res = await api(app, "PUT", "/api/global/files/x.png", {
      mediaType: "image/png",
      value: "hi",
    });
    expect(res.status).toBe(400);
  });
});

describe("versions and freeing bytes", () => {
  const put = (e: EntryStore, key: string, data: Buffer) => {
    const blob = putBlob(e.db, "image/png", data, "T");
    e.put(
      "file",
      null,
      { key, value: "", mediaType: "image/png", blob },
      { by: "user" },
    );
    return blob;
  };
  const png = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);

  it("keeps the last three versions of a binary file and frees older bytes", async () => {
    const { t, entries } = await setup();
    for (let i = 1; i <= 5; i++) put(entries, "a.png", png(i));
    const versions = entries.versions("file", null, "a.png");
    expect(BINARY_VERSIONS_KEPT).toBe(3);
    expect(versions.map((v) => v.seq)).toEqual([3, 4, 5]);
    expect(versions.map((v) => v.blob_hash)).toEqual(
      [3, 4, 5].map((i) => sha256(png(i))),
    );
    expect(blobCount(t.db)).toBe(3);
    expect(getBlob(t.db, sha256(png(1)))).toBeUndefined();
    expect(getBlob(t.db, sha256(png(5)))).toBeDefined();
  });

  it("keeps bytes that another file or version still points at", async () => {
    const { t, entries } = await setup();
    put(entries, "a.png", png(1));
    put(entries, "b.png", png(1));
    for (let i = 2; i <= 5; i++) put(entries, "a.png", png(i));
    // a.png no longer has version 1, but b.png still has the bytes.
    expect(getBlob(t.db, sha256(png(1)))).toBeDefined();
    for (let i = 2; i <= 4; i++) put(entries, "b.png", png(i));
    expect(getBlob(t.db, sha256(png(1)))).toBeUndefined();
  });

  it("deletes and restores a binary file with its bytes", async () => {
    const { app } = await setup();
    await upload(app, "/api/global", "image/png", PNG, "?name=a.png");
    await upload(
      app,
      "/api/global",
      "image/png",
      PNG2,
      "?name=a.png&replace=true",
    );
    expect((await api(app, "DELETE", "/api/global/files/a.png")).status).toBe(
      204,
    );
    expect((await api(app, "GET", "/api/global/files")).body).toEqual([]);
    const detail = await api(app, "GET", "/api/global/files/a.png");
    expect(detail.body.deleted).toBe(true);
    const first = detail.body.versions.find(
      (v: { blob?: { hash: string }; deleted: boolean }) =>
        v.blob?.hash === sha256(PNG) && !v.deleted,
    );
    const restored = await api(app, "POST", "/api/global/files/a.png/restore", {
      seq: first.seq,
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      deleted: false,
      mediaType: "image/png",
      blob: { hash: sha256(PNG) },
    });
  });

  it("restores an earlier version of a session file", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    await upload(app, base, "image/png", PNG, "?name=a.png");
    await upload(app, base, "image/png", PNG2, "?name=a.png&replace=true");
    const restored = await api(app, "POST", `${base}/files/a.png/restore`, {
      seq: 1,
    });
    expect(restored.body).toMatchObject({ blob: { hash: sha256(PNG) } });
  });
});

describe("sweepBlobs", () => {
  it("deletes bytes nothing points at and keeps those a message names", async () => {
    const { t, store, entries } = await setup();
    const used = putBlob(t.db, "image/png", PNG, "T");
    const orphan = putBlob(t.db, "image/png", PNG2, "T");
    const inEntry = putBlob(t.db, "image/jpeg", JPEG, "T");
    entries.put(
      "file",
      null,
      { key: "j.jpg", value: "", mediaType: "image/jpeg", blob: inEntry },
      { by: "user" },
    );
    const sid = randomUUID();
    store.createSession(sid, "S", "T");
    const op: EntryOp = {
      op: "put",
      kind: "file",
      key: "p.png",
      value: "",
      mediaType: "image/png",
      blob: used,
    };
    store.addMessage(
      sid,
      randomUUID(),
      { role: "edit", content: "x", entries: [op] },
      "T",
    );

    expect(sweepBlobs(t.db)).toBe(1);
    expect(getBlob(t.db, orphan.hash)).toBeUndefined();
    expect(getBlob(t.db, used.hash)).toBeDefined();
    expect(getBlob(t.db, inEntry.hash)).toBeDefined();
  });

  it("frees a session's bytes when it is purged, and a project's when it is", async () => {
    const { app, t, store } = await setup();
    const id = await newSession(app);
    await upload(app, `/api/sessions/${id}`, "image/png", PNG, "?name=a.png");
    const p = await newProject(app);
    await upload(app, `/api/projects/${p}`, "audio/wav", WAV, "?name=a.wav");
    await upload(app, "/api/global", "image/jpeg", JPEG, "?name=j.jpg");
    expect(blobCount(t.db)).toBe(3);
    store.purgeSession(id);
    expect(blobCount(t.db)).toBe(2);
    store.purgeProject(p);
    expect(blobCount(t.db)).toBe(1);
  });
});

describe("messages with files", () => {
  it("stores references and reads the bytes when the request is made", async () => {
    const { app, store, runs, model } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    await upload(app, base, "image/png", PNG, "?name=My Photo.png");

    const res = await api(app, "POST", `${base}/messages`, {
      content: "",
      files: ["session://My Photo.png"],
    });
    expect(res.status).toBe(202);
    await runAnsweringForms(runs, id, res.body.runId, []);

    const user = store.listMessages(id).find((m) => m.message.role === "user");
    expect(user?.message).toEqual({
      role: "user",
      content: "",
      files: ["session://My Photo.png"],
    });
    const request = model.requests[0] as ChatRequest;
    expect(request.resolveFile?.("session://My Photo.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(request.resolveFile?.("session://gone.png")).toBeUndefined();
  });

  it("refuses a reference to a file that is not an image or audio file", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const base = `/api/sessions/${id}`;
    await api(app, "PUT", `${base}/files/notes.md`, {
      mediaType: "text/markdown",
      value: "hi",
    });
    for (const ref of [
      "session://notes.md",
      "session://nope.png",
      "workspace://x/y.png",
      "cat.png",
    ]) {
      const res = await api(app, "POST", `${base}/messages`, {
        content: "x",
        files: [ref],
      });
      expect(res.status, ref).toBe(400);
    }
  });

  it("accepts a global file, and many files in one message", async () => {
    const { app, runs } = await setup();
    const id = await newSession(app);
    await upload(app, "/api/global", "image/png", PNG, "?name=g.png");
    const refs = ["global://g.png"];
    for (let i = 0; i < 12; i++) {
      await upload(
        app,
        `/api/sessions/${id}`,
        "image/png",
        PNG,
        `?name=p${i}.png`,
      );
      refs.push(`session://p${i}.png`);
    }
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "",
      files: refs,
    });
    expect(res.status).toBe(202);
    await runAnsweringForms(runs, id, res.body.runId, []);
  });

  it("refuses an empty message with no files", async () => {
    const { app } = await setup();
    const id = await newSession(app);
    const res = await api(app, "POST", `/api/sessions/${id}/messages`, {
      content: "",
      files: [],
    });
    expect(res.status).toBe(400);
  });
});

describe("attachmentFileName", () => {
  it("keeps a valid name, repairs a bad one and suffixes a taken one", () => {
    const taken = new Set<string>();
    expect(attachmentFileName("cat.png", "image/png", taken)).toBe("cat.png");
    expect(attachmentFileName(null, "audio/wav", taken)).toBe("attachment.wav");
    expect(attachmentFileName("NUL.png", "image/png", taken)).toBe(
      "attachment.png",
    );
    expect(attachmentFileName("a/b/c.png", "image/png", taken)).toBe("c.png");
    expect(attachmentFileName("dots...", "image/png", taken)).toBe("dots");
    expect(
      attachmentFileName("cat.png", "image/png", new Set(["cat.png"])),
    ).toBe("cat (2).png");
    expect(
      attachmentFileName(
        "cat.tar.gz",
        "image/png",
        new Set(["cat.tar.gz", "cat (2).tar.gz"]),
      ),
    ).toBe("cat (3).tar.gz");
  });
});

describe("the data step attachments-to-files", () => {
  function oldDatabase() {
    const t = tempDatabase();
    const db = t.db;
    cleanups.push(t.cleanup);
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('s', 'S', 't')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES ('other', 'O', 't')",
    ).run();
    const att = db.prepare(
      "INSERT INTO attachments (id, session_id, kind, media_type, name, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 't')",
    );
    att.run("a1", "s", "image", "image/png", "cat.png", PNG.length, PNG);
    att.run("a2", "s", "image", "image/png", "cat.png", PNG2.length, PNG2);
    att.run("a3", "s", "audio", "audio/wav", null, WAV.length, WAV);
    att.run("x1", "other", "image", "image/png", "cat.png", PNG.length, PNG);
    let seq = 0;
    const msg = (sid: string, id: string, message: unknown) =>
      db
        .prepare(
          "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES (?, ?, ?, ?, 't')",
        )
        .run(id, sid, seq++ * 10 + 5, JSON.stringify(message));
    msg("s", "m1", { role: "user", content: "hi" });
    msg("s", "m2", {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    msg("s", "m3", {
      role: "user",
      content: "look",
      attachments: [
        {
          id: "a1",
          kind: "image",
          mediaType: "image/png",
          name: "cat.png",
          size: PNG.length,
        },
        {
          id: "a2",
          kind: "image",
          mediaType: "image/png",
          name: "cat.png",
          size: PNG2.length,
        },
      ],
    });
    msg("s", "m4", {
      role: "assistant",
      content: [{ type: "text", text: "nice" }],
    });
    msg("s", "m5", {
      role: "user",
      content: "",
      attachments: [
        { id: "a3", kind: "audio", mediaType: "audio/wav" },
        { id: "gone", kind: "image", mediaType: "image/png", name: "lost.png" },
      ],
    });
    msg("other", "o1", {
      role: "user",
      content: "x",
      attachments: [
        { id: "x1", kind: "image", mediaType: "image/png", name: "cat.png" },
      ],
    });
    return db;
  }

  const messagesOf = (db: ReturnType<typeof oldDatabase>, sid: string) =>
    (
      db
        .prepare(
          "SELECT id, seq, message FROM messages WHERE session_id = ? ORDER BY seq",
        )
        .all(sid) as { id: string; seq: number; message: string }[]
    ).map((r) => ({ ...r, json: JSON.parse(r.message) }));

  it("turns attachments into session files with edit messages before the messages", () => {
    const db = oldDatabase();
    expect(attachmentsToFiles(db)).toBe(3);

    const s = messagesOf(db, "s");
    expect(s.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.map((m) => m.json.role)).toEqual([
      "user",
      "assistant",
      "edit",
      "user",
      "assistant",
      "edit",
      "user",
    ]);
    // The old messages kept their ids and order.
    expect(s.filter((m) => m.id.startsWith("m")).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);

    // The first edit adds both files, the second clashing name gets a suffix.
    expect(s[2]?.json.entries).toEqual([
      {
        op: "put",
        kind: "file",
        key: "cat.png",
        value: "",
        mediaType: "image/png",
        blob: { hash: sha256(PNG), size: PNG.length },
      },
      {
        op: "put",
        kind: "file",
        key: "cat (2).png",
        value: "",
        mediaType: "image/png",
        blob: { hash: sha256(PNG2), size: PNG2.length },
      },
    ]);
    expect(s[2]?.json.content).toBe(
      "[The user added session file cat.png; added session file cat (2).png in the app.]",
    );
    expect(s[3]?.json).toEqual({
      role: "user",
      content: "look",
      files: ["session://cat.png", "session://cat (2).png"],
    });
    // An unnamed attachment is named by its type; one whose bytes are gone
    // keeps its reference but has no file.
    expect(s[5]?.json.entries).toMatchObject([
      { key: "attachment.wav", mediaType: "audio/wav" },
    ]);
    expect(s[6]?.json).toEqual({
      role: "user",
      content: "",
      files: ["session://attachment.wav", "session://lost.png"],
    });

    // The files exist when the transcript is replayed, with their bytes.
    const state = replaySessionEntries(s.map((m) => m.json));
    expect([...state.file.keys()]).toEqual([
      "cat.png",
      "cat (2).png",
      "attachment.wav",
    ]);
    expect(getBlob(db, sha256(WAV))).toMatchObject({ mediaType: "audio/wav" });
    expect(getBlob(db, sha256(PNG))?.data.equals(PNG)).toBe(true);

    // The other session is migrated on its own; the bytes are stored once.
    const o = messagesOf(db, "other");
    expect(o.map((m) => m.json.role)).toEqual(["edit", "user"]);
    expect(o[1]?.json.files).toEqual(["session://cat.png"]);
    expect(blobCount(db)).toBe(3);

    // The old table is gone.
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name = 'attachments'")
        .get(),
    ).toBeUndefined();
  });

  it("runs once through runDataSteps and does nothing on a database without attachments", () => {
    const db = oldDatabase();
    expect(runDataSteps(db).map((r) => r.name)).toContain(
      "attachments-to-files",
    );
    const before = messagesOf(db, "s");
    expect(runDataSteps(db)).toEqual([]);
    expect(messagesOf(db, "s")).toEqual(before);
    // Called again after the table is gone, it changes nothing.
    expect(attachmentsToFiles(db)).toBe(0);
  });

  it("leaves sessions without attachments alone", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    t.db
      .prepare(
        "INSERT INTO sessions (id, title, created_at) VALUES ('s', 'S', 't')",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO messages (id, session_id, seq, message, created_at) VALUES ('m', 's', 7, ?, 't')",
      )
      .run(JSON.stringify({ role: "user", content: "hi" }));
    expect(attachmentsToFiles(t.db)).toBe(0);
    expect(
      t.db.prepare("SELECT seq FROM messages WHERE id = 'm'").get(),
    ).toEqual({ seq: 7 });
  });
});
