import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel, type ScriptStep } from "@harness/core";
import { allTools, entriesInstruction } from "@harness/tools";
import { Embedder, FIRST_RETRY_MS, MAX_RETRY_MS } from "./embedder.js";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { SearchIndex } from "./search-index.js";
import { sessionSearch } from "./search.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Search over files and memory (files and memory design, 3.6; plan S1-S8). */

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/**
 * A toy embedding: one dimension per topic, so texts about the same topic
 * are near each other even with no word in common.
 */
const TOPICS = [
  ["water", "sea", "lake", "drown", "swim", "ocean"],
  ["light", "lamp", "lens", "beam", "lighthouse"],
  ["storm", "wind", "thunder", "gale"],
];
function toyEmbed(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const v = TOPICS.map(
    (topic) => words.filter((w) => topic.some((t) => w.startsWith(t))).length,
  );
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm || 0.001);
}

function setupDb() {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  const index = new SearchIndex(t.db);
  const entries = new EntryStore(t.db, undefined, undefined, index);
  const store = new Store(t.db);
  return { t, index, entries, store };
}

const user = { by: "user" } as const;
const everywhere = (sessionId: string | null, projectId: string | null) => ({
  sessionId,
  projectId,
  global: true,
});

describe("SearchIndex", () => {
  it("keeps chunks in step with writes and deletes, with stemmed keyword search", () => {
    const { index, entries } = setupDb();
    entries.put("note", null, { key: "n1", value: "Alice fears water" }, user);
    const hits = () =>
      index
        .keyword("note", everywhere(null, null), "fear", 10)
        .map((c) => c.key);
    expect(hits()).toEqual(["n1"]);
    entries.put("note", null, { key: "n1", value: "Alice loves cake" }, user);
    expect(hits()).toEqual([]);
    entries.delete("note", null, "n1", user);
    expect(index.keyword("note", everywhere(null, null), "cake", 10)).toEqual(
      [],
    );
  });

  it("splits long files into chunks and searches only the given scopes", () => {
    const { t, index, entries, store } = setupDb();
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const long = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${i} about nothing.`,
    )
      .join("\n\n")
      .concat("\n\nThe gale arrives at dawn.");
    entries.put(
      "file",
      "p",
      { key: "draft", value: long, type: "plain" },
      user,
    );
    const chunks = t.db
      .prepare("SELECT count(*) AS n FROM chunks WHERE key = 'draft'")
      .get() as { n: number };
    expect(chunks.n).toBeGreaterThan(1);
    expect(
      index
        .keyword("file", everywhere(null, "p"), "gale", 10)
        .map((c) => c.text),
    ).toEqual([expect.stringContaining("The gale arrives at dawn.")]);
    expect(index.keyword("file", everywhere(null, null), "gale", 10)).toEqual(
      [],
    );
  });

  it("indexes existing entries and session transcripts once after the migration", () => {
    const { t, index, store } = setupDb();
    store.createSession("s", "S", "T");
    store.addMessage(
      "s",
      "m1",
      {
        role: "tool",
        callId: "c",
        name: "memory_add",
        content: "",
        isError: false,
        entries: [
          { op: "put", kind: "note", key: "a", value: "storm at midnight" },
          { op: "put", kind: "note", key: "b", value: "gone" },
          { op: "delete", kind: "note", key: "b" },
        ],
      },
      "T",
    );
    // Written without the index, as before the migration.
    new EntryStore(t.db).put(
      "file",
      null,
      { key: "g", value: "storm", type: "plain" },
      user,
    );
    t.db.prepare("UPDATE search_index_state SET built = 0").run();
    t.db.prepare("DELETE FROM chunks").run();

    expect(index.buildIfNeeded()).toBe(2);
    expect(index.buildIfNeeded()).toBeNull();
    expect(
      index
        .keyword("note", everywhere("s", null), "storm", 10)
        .map((c) => c.key),
    ).toEqual(["a"]);
    expect(
      index
        .keyword("file", everywhere(null, null), "storm", 10)
        .map((c) => c.key),
    ).toEqual(["g"]);
  });
});

describe("Embedder", () => {
  function setupEmbedder(model: { current: string }, fail?: () => boolean) {
    const db = setupDb();
    const calls: { model: string; texts: string[] }[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const errors: number[] = [];
    const embedder = new Embedder({
      index: db.index,
      model: () => model.current,
      embed: (m, texts) => {
        calls.push({ model: m, texts });
        if (fail?.()) return Promise.reject(new Error("model not loaded"));
        return Promise.resolve(texts.map(toyEmbed));
      },
      onError: (_e, ms) => errors.push(ms),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    db.index.onChunksAdded = () => embedder.kick();
    cleanups.push(() => embedder.stop());
    const vectors = () =>
      db.t.db
        .prepare(
          "SELECT model, count(*) AS n FROM chunk_vectors GROUP BY model",
        )
        .all();
    return { ...db, embedder, calls, timers, errors, vectors };
  }

  it("embeds pending chunks in batches of 16", async () => {
    const model = { current: "embed-a" };
    const { entries, embedder, calls, vectors } = setupEmbedder(model);
    for (let i = 0; i < 20; i++) {
      entries.put("note", null, { key: `n${i}`, value: `note ${i}` }, user);
    }
    await embedder.idle();
    expect(calls.map((c) => c.texts.length)).toEqual([1, 16, 3]);
    expect(vectors()).toEqual([{ model: "embed-a", n: 20 }]);
  });

  it("does nothing without a model, and re-embeds everything when it changes", async () => {
    const model = { current: "" };
    const { entries, embedder, calls, vectors } = setupEmbedder(model);
    entries.put("note", null, { key: "n", value: "x" }, user);
    await embedder.idle();
    expect(calls).toEqual([]);

    model.current = "embed-a";
    embedder.settingsChanged();
    await embedder.idle();
    expect(vectors()).toEqual([{ model: "embed-a", n: 1 }]);

    model.current = "embed-b";
    embedder.settingsChanged();
    await embedder.idle();
    expect(vectors()).toEqual([{ model: "embed-b", n: 1 }]);
    expect(calls.map((c) => c.model)).toEqual(["embed-a", "embed-b"]);
  });

  it("retries after 5 s, doubling to 5 minutes, and resets on settings changes", async () => {
    let failing = true;
    const { entries, embedder, timers, errors, vectors } = setupEmbedder(
      { current: "embed-a" },
      () => failing,
    );
    entries.put("note", null, { key: "n", value: "x" }, user);
    await embedder.idle();
    for (let i = 0; i < 8; i++) {
      timers.at(-1)?.fn();
      await embedder.idle();
    }
    expect(errors).toEqual([
      FIRST_RETRY_MS,
      10_000,
      20_000,
      40_000,
      80_000,
      160_000,
      MAX_RETRY_MS,
      MAX_RETRY_MS,
      MAX_RETRY_MS,
    ]);
    // New work does not cut a scheduled wait short.
    entries.put("note", null, { key: "m", value: "y" }, user);
    await embedder.idle();
    expect(errors).toHaveLength(9);

    embedder.settingsChanged();
    await embedder.idle();
    expect(errors.at(-1)).toBe(FIRST_RETRY_MS);
    failing = false;
    timers.at(-1)?.fn();
    await embedder.idle();
    expect(vectors()).toEqual([{ model: "embed-a", n: 2 }]);
  });
});

describe("sessionSearch", () => {
  async function seeded(model: string, embedFails = false) {
    const db = setupDb();
    db.store.createProject({ id: "p", name: "P", description: "", now: "T" });
    db.entries.put(
      "note",
      "p",
      { key: "lake", value: "Alice will not go near the lake." },
      user,
    );
    db.entries.put(
      "note",
      "p",
      { key: "lamp", value: "The lamp has a Fresnel lens." },
      user,
    );
    db.entries.put(
      "note",
      null,
      { key: "gale", value: "Storms come from the west." },
      user,
    );
    const embed = (_m: string, texts: string[]) =>
      embedFails
        ? Promise.reject(new Error("server down"))
        : Promise.resolve(texts.map(toyEmbed));
    if (model) {
      for (;;) {
        const batch = db.index.pending(model, 16);
        if (batch.length === 0) break;
        db.index.saveVectors(
          model,
          batch.map((c) => ({ id: c.id, vector: toyEmbed(c.text) })),
        );
      }
    }
    const search = sessionSearch({
      index: db.index,
      sessionId: "s",
      projectId: "p",
      embeddingModel: () => model,
      embed,
    });
    return { ...db, search };
  }

  it("finds by meaning what keywords miss, and merges both rankings", async () => {
    const { search } = await seeded("embed-a");
    const result = await search({
      kind: "note",
      query: "drowning lake",
      scopes: ["session", "project", "global"],
      limit: 2,
    });
    expect(result.mode).toBe("keyword+meaning");
    expect(result.notice).toBeUndefined();
    expect(result.hits[0]).toMatchObject({ key: "lake", matched: "both" });
    expect(result.hits).toHaveLength(2);

    const byMeaning = await search({
      kind: "note",
      query: "beam",
      scopes: ["project"],
      limit: 1,
    });
    expect(byMeaning.hits).toEqual([
      {
        scope: "project",
        key: "lamp",
        excerpt: "The lamp has a Fresnel lens.",
        matched: "meaning",
      },
    ]);
  });

  it("is keyword only, and says so, without a model or when embedding fails", async () => {
    const none = await (
      await seeded("")
    ).search({
      kind: "note",
      query: "storms",
      scopes: ["global"],
      limit: 5,
    });
    expect(none).toMatchObject({
      mode: "keyword",
      notice: "No embedding model is set, so this was a keyword search only.",
      hits: [{ key: "gale", matched: "keyword" }],
    });
    const failed = await (
      await seeded("embed-a", true)
    ).search({
      kind: "note",
      query: "storms",
      scopes: ["global"],
      limit: 5,
    });
    expect(failed.mode).toBe("keyword");
    expect(failed.notice).toContain("server down");
  });

  it("returns one hit per file, with its best chunk as the excerpt", async () => {
    const { entries, search } = await seeded("");
    const value = `${"Filler sentence here. ".repeat(80)}\n\nThe storm breaks the lens.`;
    entries.put("file", null, { key: "draft", value, type: "plain" }, user);
    const result = await search({
      kind: "file",
      query: "storm lens filler",
      scopes: ["global"],
      limit: 5,
    });
    expect(result.hits.map((h) => h.key)).toEqual(["draft"]);
  });
});

describe("search through the tools", () => {
  const TOKEN = "t".repeat(64);
  const call = (callId: string, name: string, args: object): ScriptStep => ({
    type: "tool_call",
    callId,
    name,
    arguments: JSON.stringify(args),
  });

  async function setup(scripts: ScriptStep[][]) {
    const db = setupDb();
    writeSettings(db.t.db, { embeddingModel: "embed-a" });
    const settings = () => readSettings(db.t.db, {}).effective;
    const embed = (_m: string, texts: string[]) =>
      Promise.resolve(texts.map(toyEmbed));
    const embedder = new Embedder({
      index: db.index,
      model: () => settings().embeddingModel,
      embed,
    });
    db.index.onChunksAdded = () => embedder.kick();
    let saved = 0;
    const runs = new RunManager({
      store: db.store,
      settings,
      model: () => new ScriptedModel(scripts),
      tools: allTools,
      entries: db.entries,
      systemPrompt: (s) => entriesInstruction(s.project_id !== null),
      index: db.index,
      search: (session) =>
        sessionSearch({
          index: db.index,
          sessionId: session.id,
          projectId: session.project_id,
          embeddingModel: () => settings().embeddingModel,
          embed,
        }),
    });
    const app = buildServer({
      store: db.store,
      runs,
      entries: db.entries,
      token: TOKEN,
      env: {},
      onSettingsSaved: () => saved++,
    });
    await app.ready();
    cleanups.push(
      () => app.close(),
      () => embedder.stop(),
    );
    return { ...db, runs, app, embedder, saved: () => saved };
  }

  const api = async (
    app: FastifyInstance,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ) => {
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
  };

  it("finds a note the model saved earlier in the same run", async () => {
    const { app, runs, store } = await setup([
      [
        call("c1", "memory_add", {
          scope: "session",
          text: "The keeper cannot swim.",
        }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        call("c2", "memory_search", { query: "afraid of the sea" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const { body } = await api(app, "POST", "/api/sessions", { title: "S" });
    const run = await api(app, "POST", `/api/sessions/${body.id}/messages`, {
      content: "Go",
    });
    await expect.poll(() => runs.isActive(run.body.runId)).toBe(false);
    const result = store
      .listMessages(body.id)
      .map((m) => m.message)
      .filter((m) => m.role === "tool")
      .at(-1);
    expect(result?.name).toBe("memory_search");
    expect(JSON.parse(result?.content ?? "{}")).toMatchObject({
      notes: [{ scope: "session", text: "The keeper cannot swim." }],
    });
  });

  it("indexes the user's session edits and drops a purged session's chunks", async () => {
    const { app, t } = await setup([]);
    const { body } = await api(app, "POST", "/api/sessions", { title: "S" });
    await api(app, "PUT", `/api/sessions/${body.id}/files/a`, {
      type: "plain",
      value: "thunder over the bay",
    });
    const count = () =>
      (t.db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number })
        .n;
    expect(count()).toBe(1);
    await api(app, "POST", `/api/sessions/${body.id}/trash`);
    await api(app, "DELETE", `/api/sessions/${body.id}`);
    expect(count()).toBe(0);
  });

  it("tells the embedder when settings are saved", async () => {
    const { app, saved } = await setup([]);
    await api(app, "PUT", "/api/settings", { embeddingModel: "embed-b" });
    expect(saved()).toBe(1);
  });
});
