import {
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchWorkspaces } from "./search.js";
import { SearchIndex } from "./search-index.js";
import { tempDatabase, tempDir } from "./test-helpers.js";
import { WorkspaceIndexer } from "./workspace-index.js";
import { WorkspaceStore } from "./workspaces-store.js";

/* Indexing the ticked parts of a workspace: ticks, rescans, the watcher. */

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup(
  options: { watch?: boolean; maxFiles?: number; maxBytes?: number } = {},
) {
  const t = tempDatabase();
  const folder = tempDir();
  const store = new WorkspaceStore(t.db);
  const index = new SearchIndex(t.db);
  const indexer = new WorkspaceIndexer({
    store,
    index,
    watch: false,
    debounceMs: 20,
    ...options,
  });
  const w = store.create({ name: "Book", path: folder.dir, writable: true });
  cleanups.push(() => indexer.stop(), folder.cleanup, t.cleanup);
  const dir = folder.dir;
  const put = (rel: string, text: string | Buffer) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  };
  const keys = () =>
    (
      t.db
        .prepare(
          "SELECT DISTINCT key FROM chunks WHERE scope = 'workspace' AND owner_id = ? ORDER BY key",
        )
        .all(w.id) as { key: string }[]
    ).map((r) => r.key);
  const tick = async (...ticks: string[]) => {
    store.setTicks(w.id, ticks);
    return indexer.refresh(w.id);
  };
  const find = async (query: string, ids = [w.id]) =>
    (
      await searchWorkspaces(
        { index, embeddingModel: () => "", embed: () => Promise.resolve([]) },
        { query, limit: 10, workspaceIds: ids },
      )
    ).hits;
  return { t, store, index, indexer, w, dir, put, keys, tick, find };
}

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for the index.");
}

describe("ticking", () => {
  it("indexes nothing until something is ticked", async () => {
    const { put, indexer, w, keys } = setup();
    put("a.md", "the lighthouse");
    expect((await indexer.refresh(w.id))?.files).toBeUndefined();
    expect(keys()).toEqual([]);
  });

  it("indexes a ticked folder and everything below it", async () => {
    const { put, tick, keys } = setup();
    put("a.md", "alpha");
    put("notes/b.md", "bravo");
    put("notes/deep/c.md", "charlie");
    put("other/d.md", "delta");
    const r = await tick("notes");
    expect(r).toMatchObject({ indexed: 2, removed: 0, files: 2 });
    expect(keys()).toEqual(["notes/b.md", "notes/deep/c.md"]);
  });

  it("indexes the whole folder when the empty tick is set, and one file when a file is", async () => {
    const { put, tick, keys } = setup();
    put("a.md", "alpha");
    put("n/b.md", "bravo");
    await tick("");
    expect(keys()).toEqual(["a.md", "n/b.md"]);
    await tick("a.md");
    expect(keys()).toEqual(["a.md"]);
  });

  it("drops the chunks of what is unticked, and of everything when no tick is left", async () => {
    const { put, tick, keys, t, w } = setup();
    put("a.md", "alpha");
    put("b.md", "bravo");
    await tick("a.md", "b.md");
    expect((await tick("a.md"))?.removed).toBe(1);
    expect(keys()).toEqual(["a.md"]);
    await tick();
    expect(keys()).toEqual([]);
    expect(
      t.db
        .prepare(
          "SELECT count(*) AS n FROM workspace_index_files WHERE workspace_id = ?",
        )
        .get(w.id),
    ).toEqual({ n: 0 });
  });

  it("finds a file by its words and gives its path", async () => {
    const { put, tick, find, w } = setup();
    put("notes/keeper.md", "The lighthouse keeper wrote letters at night.");
    put("notes/other.md", "A quiet market in spring.");
    await tick("notes");
    const hits = await find("lighthouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workspaceId: w.id,
      path: "notes/keeper.md",
    });
    expect(hits[0]?.excerpt).toContain("lighthouse");
  });
});

describe("rescans", () => {
  it("picks up a new file in a ticked folder, a change and a delete", async () => {
    const { put, tick, indexer, w, dir, keys, find } = setup();
    put("n/a.md", "alpha");
    await tick("n");
    put("n/new.md", "a zeppelin over the bay");
    put("outside.md", "zeppelin");
    expect(await indexer.scan(w.id)).toMatchObject({
      indexed: 1,
      unchanged: 1,
    });
    expect(keys()).toEqual(["n/a.md", "n/new.md"]);

    put("n/a.md", "now about an armadillo, longer than before");
    expect((await indexer.scan(w.id)).indexed).toBe(1);
    expect((await find("armadillo")).map((h) => h.path)).toEqual(["n/a.md"]);
    expect(await find("alpha")).toEqual([]);

    rmSync(join(dir, "n/new.md"));
    expect(await indexer.scan(w.id)).toMatchObject({ removed: 1, files: 1 });
    expect(keys()).toEqual(["n/a.md"]);
  });

  it("sees a rename as the old path gone and the new one added", async () => {
    const { put, tick, indexer, w, dir, keys } = setup();
    put("n/old.md", "alpha");
    await tick("n");
    renameSync(join(dir, "n/old.md"), join(dir, "n/new.md"));
    expect(await indexer.scan(w.id)).toMatchObject({ indexed: 1, removed: 1 });
    expect(keys()).toEqual(["n/new.md"]);
  });

  it("does not read a file again while its time and size are the same", async () => {
    const { put, tick, indexer, w, dir, t } = setup();
    put("a.md", "alpha");
    await tick("");
    const ids = () =>
      t.db.prepare("SELECT id FROM chunks WHERE scope = 'workspace'").all();
    const before = ids();
    expect(await indexer.scan(w.id)).toMatchObject({
      indexed: 0,
      unchanged: 1,
    });
    expect(ids()).toEqual(before);
    // Same size, new time: read again.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "a.md"), later, later);
    expect((await indexer.scan(w.id)).indexed).toBe(1);
  });

  it("indexes text only, and within the limits", async () => {
    const { put, tick, keys, t, w } = setup({ maxBytes: 100 });
    put("a.md", "alpha");
    put("img.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    put("bin.dat", Buffer.from([0, 1, 2, 3, 0, 0, 255]));
    put("big.md", "x ".repeat(200));
    await tick("");
    expect(keys()).toEqual(["a.md"]);
    // The others are remembered, so they are not read again.
    expect(
      t.db
        .prepare(
          "SELECT count(*) AS n FROM workspace_index_files WHERE workspace_id = ?",
        )
        .get(w.id),
    ).toEqual({ n: 4 });
  });

  it("stops at the file limit and says so", async () => {
    const { put, tick, indexer, w } = setup({ maxFiles: 3 });
    for (const n of "abcde") put(`${n}.md`, `file ${n}`);
    const r = await tick("");
    expect(r).toMatchObject({ files: 3, truncated: true });
    expect(indexer.status(w.id)).toMatchObject({ files: 3, truncated: true });
  });

  it("leaves out a link that goes out of the folder", async () => {
    const { put, tick, keys, dir } = setup();
    const other = tempDir();
    cleanups.push(other.cleanup);
    writeFileSync(join(other.dir, "secret.md"), "secret");
    put("a.md", "alpha");
    put("real.md", "real");
    symlinkSync(join(other.dir, "secret.md"), join(dir, "out.md"));
    symlinkSync(other.dir, join(dir, "dir-out"));
    symlinkSync(join(dir, "real.md"), join(dir, "in.md"));
    await tick("");
    expect(keys()).toEqual(["a.md", "in.md", "real.md"]);
  });

  it("keeps the index when the folder is missing, and says it is unavailable", async () => {
    const { put, tick, indexer, w, dir, keys } = setup();
    put("a.md", "alpha");
    await tick("");
    rmSync(dir, { recursive: true, force: true });
    const r = await indexer.scan(w.id);
    expect(r).toMatchObject({ unavailable: true, files: 1 });
    expect(keys()).toEqual(["a.md"]);
    expect(indexer.status(w.id).unavailable).toBe(true);
  });

  it("runs a scan asked for during a scan once more", async () => {
    const { put, tick, indexer, w, keys } = setup();
    put("a.md", "alpha");
    await tick("");
    const first = indexer.scan(w.id);
    put("b.md", "bravo");
    await Promise.all([first, indexer.scan(w.id)]);
    expect(keys()).toEqual(["a.md", "b.md"]);
  });

  it("scans the live workspaces with ticks when it starts, and skips the rest", async () => {
    const { put, store, indexer, w, keys, t, index } = setup();
    put("a.md", "alpha");
    store.setTicks(w.id, [""]);
    const other = tempDir();
    cleanups.push(other.cleanup);
    writeFileSync(join(other.dir, "z.md"), "zulu");
    const w2 = store.create({
      name: "Other",
      path: other.dir,
      writable: false,
    });
    await indexer.start();
    expect(keys()).toEqual(["a.md"]);
    expect(index.db).toBe(t.db);
    expect(indexer.status(w2.id).files).toBe(0);
  });

  it("scans for a session that is starting", async () => {
    const { put, store, indexer, w, keys } = setup();
    put("a.md", "alpha");
    store.setTicks(w.id, [""]);
    await indexer.scanAll([w.id, "missing"]);
    expect(keys()).toEqual(["a.md"]);
  });
});

describe("the trash", () => {
  it("drops the chunks of a workspace in the trash, and indexes it again on restore", async () => {
    const { put, tick, store, indexer, w, keys } = setup();
    put("a.md", "alpha");
    await tick("");
    store.trash(w.id);
    await indexer.refresh(w.id);
    expect(keys()).toEqual([]);
    store.restore(w.id);
    await indexer.refresh(w.id);
    expect(keys()).toEqual(["a.md"]);
  });
});

describe("embeddings", () => {
  it("queues new chunks for the embedder like any other", async () => {
    const { put, tick, index, indexer, w } = setup();
    let added = 0;
    index.onChunksAdded = () => added++;
    put("a.md", "alpha");
    await tick("");
    expect(added).toBe(1);
    expect(
      index.pending("m", 10).map((c) => [c.scope, c.ownerId, c.key]),
    ).toEqual([["workspace", w.id, "a.md"]]);
    // Nothing changed: nothing queued.
    await indexer.scan(w.id);
    expect(added).toBe(1);
  });
});

describe("the watcher", () => {
  it("indexes a new file, a change, a rename and a delete in a ticked folder", async () => {
    const { put, tick, dir, keys, t, w } = setup({ watch: true });
    const armadillo = () =>
      t.db
        .prepare(
          "SELECT count(*) AS n FROM chunks WHERE scope = 'workspace' AND owner_id = ? AND text LIKE '%armadillo%'",
        )
        .get(w.id) as { n: number };
    put("n/a.md", "alpha");
    put("outside/o.md", "omega");
    await tick("n");
    expect(keys()).toEqual(["n/a.md"]);

    put("n/new.md", "a zeppelin over the bay");
    await until(() => keys().includes("n/new.md"));

    put("n/a.md", "an armadillo, which is longer than before");
    await until(() => armadillo().n > 0);

    renameSync(join(dir, "n/new.md"), join(dir, "n/renamed.md"));
    await until(
      () => keys().includes("n/renamed.md") && !keys().includes("n/new.md"),
    );

    rmSync(join(dir, "n/renamed.md"));
    await until(() => !keys().includes("n/renamed.md"));

    // A change outside the ticked folder is not seen.
    put("outside/p.md", "pi");
    await new Promise((r) => setTimeout(r, 300));
    expect(keys()).toEqual(["n/a.md"]);
  }, 30000);

  it("moves to the new ticks, and stops when they are cleared", async () => {
    const { put, tick, indexer, w, keys } = setup({ watch: true });
    put("a/x.md", "x");
    put("b/y.md", "y");
    await tick("a");
    await tick("b");
    expect(keys()).toEqual(["b/y.md"]);
    put("a/late.md", "late");
    await new Promise((r) => setTimeout(r, 300));
    expect(keys()).toEqual(["b/y.md"]);
    put("b/new.md", "new");
    await until(() => keys().includes("b/new.md"));
    await tick();
    expect(keys()).toEqual([]);
    expect(indexer.status(w.id).files).toBe(0);
  }, 30000);
});
