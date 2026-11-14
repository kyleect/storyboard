import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrate } from "./migrate.js";
import { Store } from "./store.js";
import { MIGRATIONS_DIR, tempDatabase } from "./test-helpers.js";

/*
 * A project's color: migration 0036 and the store. The routes are covered in
 * server.test.ts.
 */

const NOW = "2026-01-01T00:00:00.000Z";

describe("migration 0036 (project color)", () => {
  let db: Database.Database;
  afterEach(() => {
    if (db?.open) db.close();
  });

  it("leaves existing projects without a color", () => {
    db = new Database(":memory:");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 35),
    );
    db.prepare(
      "INSERT INTO projects (id, name, created_at, last_used_at) VALUES ('p1', 'Old', ?, ?)",
    ).run(NOW, NOW);

    expect(migrate(db, all)).toEqual([36]);

    expect(db.prepare("SELECT id, name, color FROM projects").all()).toEqual([
      { id: "p1", name: "Old", color: null },
    ]);
  });
});

describe("a project's color in the store", () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  function setup() {
    const t = tempDatabase();
    cleanup = t.cleanup;
    return new Store(t.db);
  }

  it("is none unless one is given", () => {
    const store = setup();
    const plain = store.createProject({
      id: "p1",
      name: "Plain",
      description: "",
      now: NOW,
    });
    expect(plain.color).toBeNull();
    expect(store.getProject("p1")?.color).toBeNull();
  });

  it("is stored when the project is created", () => {
    const store = setup();
    const created = store.createProject({
      id: "p1",
      name: "Sea",
      description: "",
      color: "teal",
      now: NOW,
    });
    expect(created.color).toBe("teal");
    expect(store.getProject("p1")?.color).toBe("teal");
    expect(store.listProjects().map((p) => p.color)).toEqual(["teal"]);
  });

  it("is changed and removed without touching the other fields", () => {
    const store = setup();
    store.createProject({
      id: "p1",
      name: "Sea",
      description: "Short pieces.",
      now: NOW,
    });

    store.updateProject("p1", { color: "grape" });
    expect(store.getProject("p1")).toMatchObject({
      name: "Sea",
      description: "Short pieces.",
      color: "grape",
    });

    // A field left out is unchanged.
    store.updateProject("p1", { name: "Sea stories" });
    expect(store.getProject("p1")).toMatchObject({
      name: "Sea stories",
      color: "grape",
    });

    store.updateProject("p1", { color: null });
    expect(store.getProject("p1")?.color).toBeNull();
  });

  it("stays with a project through the trash", () => {
    const store = setup();
    store.createProject({
      id: "p1",
      name: "Sea",
      description: "",
      color: "orange",
      now: NOW,
    });
    store.trashProject("p1", NOW);
    expect(store.listTrashedProjects().map((p) => p.color)).toEqual(["orange"]);
    store.restoreProject("p1", "all");
    expect(store.getProject("p1")?.color).toBe("orange");
  });
});
