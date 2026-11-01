import { afterEach, describe, expect, it } from "vitest";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { tempDatabase, type TempDatabase } from "./test-helpers.js";
import { purgeExpiredTrash } from "./trash.js";

let t: TempDatabase | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function storeWith(sessions: { id: string; trashedAt: string | null }[]) {
  t = tempDatabase();
  const store = new Store(t.db);
  for (const s of sessions) {
    store.createSession(s.id, s.id, "2026-01-01T00:00:00.000Z");
    store.setSessionTrashed(s.id, s.trashedAt);
  }
  return store;
}

describe("purgeExpiredTrash", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");

  it("purges sessions trashed more than the given days ago", () => {
    const store = storeWith([
      { id: "old", trashedAt: "2026-09-30T11:59:59.000Z" },
      { id: "recent", trashedAt: "2026-10-30T12:00:00.000Z" },
      { id: "active", trashedAt: null },
    ]);
    expect(purgeExpiredTrash(store, 30, now)).toEqual({
      projects: [],
      sessions: ["old"],
    });
    expect(store.getSession("old")).toBeUndefined();
    expect(store.getSession("recent")).toBeDefined();
    expect(store.getSession("active")).toBeDefined();
  });

  it("purges nothing when set to 0", () => {
    const store = storeWith([
      { id: "old", trashedAt: "2020-01-01T00:00:00.000Z" },
    ]);
    expect(purgeExpiredTrash(store, 0, now)).toEqual({
      projects: [],
      sessions: [],
    });
    expect(store.getSession("old")).toBeDefined();
  });
});

describe("purgeExpiredTrash with projects", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");

  it("purges a project, with its sessions, counted from when it was trashed", () => {
    t = tempDatabase();
    const store = new Store(t.db);
    const created = "2026-01-01T00:00:00.000Z";
    for (const id of ["old", "recent"]) {
      store.createProject({ id, name: id, description: "", now: created });
      store.createSession(`${id}-s`, "s", created, id);
    }
    // Trashed on its own long ago, in a project trashed recently.
    store.createSession("alone", "s", created, "recent");
    store.setSessionTrashed("alone", "2026-01-02T00:00:00.000Z");
    store.trashProject("old", "2026-09-01T00:00:00.000Z");
    store.trashProject("recent", "2026-10-30T00:00:00.000Z");

    expect(purgeExpiredTrash(store, 30, now)).toEqual({
      projects: ["old"],
      sessions: ["alone"],
    });
    expect(store.getProject("old")).toBeUndefined();
    expect(store.getSession("old-s")).toBeUndefined();
    expect(store.getProject("recent")).toBeDefined();
    expect(store.getSession("recent-s")).toBeDefined();
  });
});

describe("trashRetentionDays setting", () => {
  it("defaults to 30 and reads HARNESS_TRASH_RETENTION_DAYS", () => {
    t = tempDatabase();
    const { db } = t;
    expect(readSettings(db, {}).effective.trashRetentionDays).toBe(30);
    expect(
      readSettings(db, { HARNESS_TRASH_RETENTION_DAYS: "0" }).effective
        .trashRetentionDays,
    ).toBe(0);
    expect(() =>
      readSettings(db, { HARNESS_TRASH_RETENTION_DAYS: "-1" }),
    ).toThrow(/HARNESS_TRASH_RETENTION_DAYS/);
  });
});
