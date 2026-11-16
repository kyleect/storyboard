import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  EmbeddingError,
  embedTexts,
  ScriptedModel,
  type ScriptStep,
} from "@harness/core";
import { FakeLlamaServer, FakeServerError } from "@harness/core/testing";
import { allTools, filesInstruction } from "@harness/tools";
import {
  Embedder,
  FIRST_RETRY_MS,
  MAX_RETRY_MS,
  MIN_CHUNK_CHARS,
  type ChunkEvent,
} from "./embedder.js";
import { openDatabase } from "./db.js";
import { FileStore } from "./files-store.js";
import { RunManager } from "./runs.js";
import { SearchIndex } from "./search-index.js";
import { fusedSearch, sessionSearch } from "./search.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { runAnsweringForms, tempDatabase } from "./test-helpers.js";

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
  const files = new FileStore(t.db, undefined, undefined, index);
  const store = new Store(t.db);
  return { t, index, files, store };
}

const user = { by: "user" } as const;
const everywhere = (sessionId: string | null, projectId: string | null) => ({
  sessionId,
  projectId,
  global: true,
});

describe("SearchIndex", () => {
  it("keeps chunks in step with writes and deletes, with stemmed keyword search", () => {
    const { index, files } = setupDb();
    files.put(null, { key: "n1", value: "Alice fears water" }, user);
    const hits = () =>
      index.keyword(everywhere(null, null), "fear", 10).map((c) => c.key);
    expect(hits()).toEqual(["n1"]);
    files.put(null, { key: "n1", value: "Alice loves cake" }, user);
    expect(hits()).toEqual([]);
    files.delete(null, "n1", user);
    expect(index.keyword(everywhere(null, null), "cake", 10)).toEqual([]);
  });

  it("splits long files into chunks and searches only the given scopes", () => {
    const { t, index, files, store } = setupDb();
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const long = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${i} about nothing.`,
    )
      .join("\n\n")
      .concat("\n\nThe gale arrives at dawn.");
    files.put(
      "p",
      { key: "draft", value: long, mediaType: "text/plain" },
      user,
    );
    const chunks = t.db
      .prepare("SELECT count(*) AS n FROM chunks WHERE key = 'draft'")
      .get() as { n: number };
    expect(chunks.n).toBeGreaterThan(1);
    expect(
      index.keyword(everywhere(null, "p"), "gale", 10).map((c) => c.text),
    ).toEqual([expect.stringContaining("The gale arrives at dawn.")]);
    expect(index.keyword(everywhere(null, null), "gale", 10)).toEqual([]);
  });

  it("indexes existing files and session transcripts once after the migration", () => {
    const { t, index, store } = setupDb();
    store.createSession("s", "S", "T");
    store.addMessage(
      "s",
      "m1",
      {
        role: "tool",
        callId: "c",
        name: "files_write",
        content: "",
        isError: false,
        files: [
          { op: "put", key: "a", value: "storm at midnight" },
          { op: "put", key: "b", value: "gone" },
          { op: "delete", key: "b" },
        ],
      },
      "T",
    );
    // Written without the index, as before the migration.
    new FileStore(t.db).put(
      null,
      { key: "g", value: "storm", mediaType: "text/plain" },
      user,
    );
    t.db.prepare("UPDATE search_index_state SET built = 0").run();
    t.db.prepare("DELETE FROM chunks").run();

    expect(index.buildIfNeeded()).toBe(2);
    expect(index.buildIfNeeded()).toBeNull();
    expect(
      index
        .keyword(everywhere("s", null), "storm", 10)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["a", "g"]);
    expect(
      index.keyword(everywhere(null, null), "storm", 10).map((c) => c.key),
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
    const { files, embedder, calls, vectors } = setupEmbedder(model);
    for (let i = 0; i < 20; i++) {
      files.put(null, { key: `n${i}`, value: `note ${i}` }, user);
    }
    await embedder.idle();
    expect(calls.map((c) => c.texts.length)).toEqual([1, 16, 3]);
    expect(vectors()).toEqual([{ model: "embed-a", n: 20 }]);
  });

  it("does nothing without a model, and re-embeds everything when it changes", async () => {
    const model = { current: "" };
    const { files, embedder, calls, vectors } = setupEmbedder(model);
    files.put(null, { key: "n", value: "x" }, user);
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
    const { files, embedder, timers, errors, vectors } = setupEmbedder(
      { current: "embed-a" },
      () => failing,
    );
    files.put(null, { key: "n", value: "x" }, user);
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
    files.put(null, { key: "m", value: "y" }, user);
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

/*
 * An input that is too big for the embedding model: llama-server refuses it,
 * and it fails the whole request (tools/server/server-context.cpp). The size
 * is counted in characters here, standing in for tokens.
 */
const refusals = {
  "the batch size": (n: number) =>
    new EmbeddingError(
      `input (${n} tokens) is too large to process. increase the physical batch size (current batch size: 500)`,
      500,
      "server_error",
    ),
  "the context size": (n: number) =>
    new EmbeddingError(
      `input (${n} tokens) is larger than the max context size (500 tokens). skipping`,
      400,
      "exceed_context_size_error",
    ),
  // A message this code does not know: only the tiny test input tells it
  // from a sick server.
  "an unknown reason": () =>
    new EmbeddingError("something nobody has seen", 500, "server_error"),
};

describe("Embedder with chunks too big for the model", () => {
  function setupLimited(refuse: (n: number) => Error, limit = 500) {
    const db = setupDb();
    const model = { current: "" };
    const calls: string[][] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const errors: number[] = [];
    const events: ChunkEvent[] = [];
    const embedder = new Embedder({
      index: db.index,
      model: () => model.current,
      embed: (_m, texts) => {
        calls.push(texts);
        const big = texts.find((t) => t.length > limit);
        return big === undefined
          ? Promise.resolve(texts.map(toyEmbed))
          : Promise.reject(refuse(big.length));
      },
      onError: (_e, ms) => errors.push(ms),
      onChunk: (e) => events.push(e),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    db.index.onChunksAdded = () => embedder.kick();
    cleanups.push(() => embedder.stop());
    /** Starts embedding what was written while there was no model. */
    const start = async () => {
      model.current = "embed-a";
      embedder.settingsChanged();
      await embedder.idle();
    };
    const rows = (key?: string) =>
      db.t.db
        .prepare(
          `SELECT id, seq, text, EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.id) AS embedded
           FROM chunks c WHERE ? IS NULL OR key = ? ORDER BY seq, id`,
        )
        .all(key ?? null, key ?? null) as {
        id: number;
        seq: number;
        text: string;
        embedded: number;
      }[];
    return {
      ...db,
      embedder,
      model,
      calls,
      timers,
      errors,
      events,
      start,
      rows,
    };
  }

  /** 1,400 characters of one run: a single chunk. */
  const dense = Array.from({ length: 1400 }, (_, i) =>
    String.fromCharCode(97 + (i % 26)),
  ).join("");

  describe.each(Object.entries(refusals))("refused for %s", (_, refuse) => {
    it("splits only the chunk that is too big, embeds every piece, and does not hold up the rest", async () => {
      const c = setupLimited(refuse);
      // The big chunk comes first, in one batch of 16 with 15 small ones: it
      // is what used to fail the batch forever.
      c.files.put(null, { key: "big", value: dense }, user);
      for (let i = 0; i < 15; i++) {
        c.files.put(null, { key: `n${i}`, value: `note ${i}` }, user);
      }
      await c.start();

      expect(c.rows().every((r) => r.embedded === 1)).toBe(true);
      const pieces = c.rows("big");
      expect(pieces.map((p) => p.seq)).toEqual([0, 1, 2, 3]);
      expect(pieces.map((p) => p.text).join("")).toBe(dense);
      expect(c.rows()).toHaveLength(15 + 4);
      expect(c.events.map((e) => e.kind)).toEqual(["split", "split", "split"]);
      // A chunk that is refused is not a failure of the server.
      expect(c.errors).toEqual([]);
      expect(c.timers).toEqual([]);
    });
  });

  it("renumbers the later chunks of the file so seq stays the position", async () => {
    const c = setupLimited(refusals["the batch size"], 600);
    const value = ["a", "b", "c"].map((ch) => ch.repeat(1000)).join("\n\n");
    c.files.put(null, { key: "f", value }, user);
    expect(c.rows("f").map((r) => r.seq)).toEqual([0, 1, 2]);
    await c.start();
    const rows = c.rows("f");
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
    expect(rows.map((r) => r.text).join("")).toBe(value.replace(/\s/g, ""));
    expect(rows.every((r) => r.embedded === 1 && r.text.length <= 600)).toBe(
      true,
    );
  });

  it("keeps the keyword index and vectors in step, also after reopening the database", async () => {
    const c = setupLimited(refusals["the batch size"]);
    const value = Array.from(
      { length: 100 },
      (_, i) => `Sentence ${i} mentions zebra${i}.`,
    ).join(" ");
    c.files.put(null, { key: "zoo", value }, user);
    const before = c.rows("zoo").map((r) => r.id);
    await c.start();

    const check = (db: typeof c.t.db) => {
      const index = new SearchIndex(db);
      const found = index.keyword(everywhere(null, null), "zebra42", 10);
      expect(found).toHaveLength(1);
      expect(found[0]?.text.length).toBeLessThanOrEqual(500);
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const rows = count("SELECT count(*) AS n FROM chunks");
      expect(rows).toBeGreaterThan(before.length);
      expect(count("SELECT count(*) AS n FROM chunk_vectors")).toBe(rows);
      expect(
        count(
          "SELECT count(*) AS n FROM chunk_vectors WHERE chunk_id NOT IN (SELECT id FROM chunks)",
        ),
      ).toBe(0);
      expect(
        count(
          `SELECT count(*) AS n FROM chunks WHERE id IN (${before.join(",")})`,
        ),
      ).toBe(0);
      // Throws when the full-text index differs from the chunks.
      db.prepare(
        "INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('integrity-check', 1)",
      ).run();
    };
    check(c.t.db);
    c.t.db.close();
    const reopened = openDatabase(c.t.dbPath, c.t.key);
    cleanups.push(() => {
      reopened.close();
    });
    check(reopened);
  });

  it("gives up on a short chunk that is still refused, finishes the rest, and tries it again after a settings change", async () => {
    const c = setupLimited(refusals["the batch size"], 50);
    c.files.put(null, { key: "wide", value: "z".repeat(300) }, user);
    for (let i = 0; i < 3; i++) {
      c.files.put(null, { key: `n${i}`, value: `note ${i}` }, user);
    }
    await c.start();

    const stuck = c.rows("wide");
    expect(stuck).toHaveLength(2);
    expect(stuck.every((r) => r.embedded === 0)).toBe(true);
    expect(stuck.every((r) => r.text.length <= MIN_CHUNK_CHARS)).toBe(true);
    expect(c.events.map((e) => e.kind)).toEqual([
      "split",
      "skipped",
      "skipped",
    ]);
    expect(c.rows().filter((r) => r.embedded === 1)).toHaveLength(3);
    expect(c.errors).toEqual([]);

    // Not tried again on its own, however often work is kicked.
    const requests = c.calls.length;
    c.embedder.kick();
    await c.embedder.idle();
    expect(c.calls).toHaveLength(requests);

    // A settings change tries them once more.
    c.embedder.settingsChanged();
    await c.embedder.idle();
    expect(c.events.filter((e) => e.kind === "skipped")).toHaveLength(4);
    expect(c.rows("wide").map((r) => r.text)).toEqual(stuck.map((r) => r.text));
  });

  it("does not split a chunk that is deleted meanwhile", async () => {
    const c = setupLimited(refusals["the batch size"]);
    c.files.put(null, { key: "big", value: dense }, user);
    const [chunk] = c.index.pending("embed-a", 1);
    c.files.delete(null, "big", user);
    expect(c.index.splitChunk(chunk?.id ?? 0, 100)).toBeUndefined();
  });

  it("treats a server that cannot be reached, or fails the test input too, as a failure to wait out", async () => {
    // Not reachable: no HTTP answer at all.
    const down = setupLimited(
      () => new EmbeddingError("Could not reach llama-server: refused"),
    );
    down.files.put(null, { key: "big", value: dense }, user);
    await down.start();
    expect(down.errors).toEqual([FIRST_RETRY_MS]);
    expect(down.rows("big")).toHaveLength(1);

    // Answering 500 to everything, the test input included.
    const sick = setupLimited(
      () => new EmbeddingError("model failed to load", 500, "server_error"),
      0,
    );
    sick.files.put(null, { key: "a", value: "alpha" }, user);
    sick.files.put(null, { key: "b", value: "beta" }, user);
    await sick.start();
    expect(sick.errors).toEqual([FIRST_RETRY_MS]);
    expect(sick.events).toEqual([]);
    expect(sick.rows().map((r) => r.text)).toEqual(["alpha", "beta"]);
    // Still pending, and tried again when the wait is over.
    expect(sick.rows().every((r) => r.embedded === 0)).toBe(true);
  });

  it("finds a message whose text was split once, by the message", async () => {
    const c = setupLimited(refusals["the batch size"]);
    const text = Array.from(
      { length: 100 },
      (_, i) => `Sentence ${i} mentions zebra${i}.`,
    ).join(" ");
    c.index.indexMessage("s1", "m1", { role: "user", content: text });
    await c.start();
    expect(c.rows().length).toBeGreaterThan(2);

    const found = await fusedSearch(
      {
        index: c.index,
        embeddingModel: () => "embed-a",
        embed: (_m, texts) => Promise.resolve(texts.map(toyEmbed)),
      },
      {
        sessionId: null,
        projectId: null,
        global: false,
        transcriptSessionIds: ["s1"],
      },
      "zebra7 zebra91",
      undefined,
      undefined,
    );
    expect(found.hits.map((h) => [h.row.ownerId, h.row.key])).toEqual([
      ["s1", "m1"],
    ]);
  });

  describe("against a fake llama-server", () => {
    it.each([
      ["500 server_error", 500, "server_error"],
      ["400 exceed_context_size_error", 400, "exceed_context_size_error"],
    ])(
      "embeds everything when it answers %s for a big input",
      async (_, status, type) => {
        const llama = new FakeLlamaServer();
        const url = await llama.start();
        cleanups.push(() => llama.stop());
        llama.onEmbeddings((inputs) => {
          const big = inputs.find((t) => t.length > 500);
          return big === undefined
            ? inputs.map(toyEmbed)
            : new FakeServerError(
                `input (${big.length} tokens) is too large to process. increase the physical batch size (current batch size: 500)`,
                status,
                type,
              );
        });
        const db = setupDb();
        const model = { current: "embed-a" };
        const embedder = new Embedder({
          index: db.index,
          model: () => model.current,
          embed: (m, texts, signal) =>
            embedTexts(url, m, texts, signal ? { signal } : {}),
        });
        db.index.onChunksAdded = () => embedder.kick();
        cleanups.push(() => embedder.stop());
        db.files.put(null, { key: "big", value: dense }, user);
        db.files.put(null, { key: "small", value: "a small note" }, user);
        await embedder.idle();

        const left = db.t.db
          .prepare(
            "SELECT count(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_vectors)",
          )
          .get() as { n: number };
        expect(left.n).toBe(0);
        const text = db.t.db
          .prepare("SELECT text FROM chunks WHERE key = 'big' ORDER BY seq")
          .all() as { text: string }[];
        expect(text.map((r) => r.text).join("")).toBe(dense);
      },
    );
  });
});

describe("sessionSearch", () => {
  async function seeded(model: string, embedFails = false) {
    const db = setupDb();
    db.store.createProject({ id: "p", name: "P", description: "", now: "T" });
    db.files.put(
      "p",
      { key: "lake", value: "Alice will not go near the lake." },
      user,
    );
    db.files.put(
      "p",
      { key: "lamp", value: "The lamp has a Fresnel lens." },
      user,
    );
    db.files.put(
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

  it("returns every match when no limit is given", async () => {
    const { search } = await seeded("embed-a");
    const result = await search({
      query: "lake",
      scopes: ["session", "project", "global"],
    });
    expect(result.hits[0]).toMatchObject({ key: "lake" });
    expect(result.hits.map((h) => h.key).sort()).toEqual([
      "gale",
      "lake",
      "lamp",
    ]);
  });

  it("finds by meaning what keywords miss, and merges both rankings", async () => {
    const { search } = await seeded("embed-a");
    const result = await search({
      query: "drowning lake",
      scopes: ["session", "project", "global"],
      limit: 2,
    });
    expect(result.mode).toBe("keyword+meaning");
    expect(result.notice).toBeUndefined();
    expect(result.hits[0]).toMatchObject({ key: "lake", matched: "both" });
    expect(result.hits).toHaveLength(2);

    const byMeaning = await search({
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
      query: "storms",
      scopes: ["global"],
      limit: 5,
    });
    expect(failed.mode).toBe("keyword");
    expect(failed.notice).toContain("server down");
  });

  it("returns one hit per file, with its best chunk as the excerpt", async () => {
    const { files, search } = await seeded("");
    const value = `${"Filler sentence here. ".repeat(80)}\n\nThe storm breaks the lens.`;
    files.put(null, { key: "draft", value, mediaType: "text/plain" }, user);
    const result = await search({
      query: "storm lens filler",
      scopes: ["global"],
      limit: 5,
    });
    // One hit for the file however many of its chunks matched.
    expect(result.hits.filter((h) => h.key === "draft")).toHaveLength(1);
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
      files: db.files,
      systemPrompt: (s) => filesInstruction(s.project_id !== null),
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
      files: db.files,
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

  it("finds a file the model saved earlier in the same run", async () => {
    const { app, runs, store } = await setup([
      [
        call("c1", "files_write", {
          scope: "session",
          key: "keeper.md",
          mediaType: "text/markdown",
          value: "The keeper cannot swim.",
        }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        call("c2", "files_search", { query: "afraid of the sea" }),
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
    // The user confirms the file's name and scope (tool prompts D1).
    await runAnsweringForms(runs, body.id, run.body.runId, [
      { name: "keeper.md", scope: "session" },
    ]);
    const result = store
      .listMessages(body.id)
      .map((m) => m.message)
      .filter((m) => m.role === "tool")
      .at(-1);
    expect(result?.name).toBe("files_search");
    expect(JSON.parse(result?.content ?? "{}")).toMatchObject({
      results: [{ scope: "session", key: "keeper.md" }],
    });
  });

  it("indexes the user's session edits and drops a purged session's chunks", async () => {
    const { app, t } = await setup([]);
    const { body } = await api(app, "POST", "/api/sessions", { title: "S" });
    await api(app, "PUT", `/api/sessions/${body.id}/files/a`, {
      mediaType: "text/plain",
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
