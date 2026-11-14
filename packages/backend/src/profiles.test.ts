import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { DataStore } from "./data-store.js";
import { ErrorStore } from "./errors-store.js";
import { FileStore } from "./files-store.js";
import { schemaChecker } from "./json-schema.js";
import { McpServerStore } from "./mcp-store.js";
import { loadMigrations, migrate } from "./migrate.js";
import {
  BUILTIN_PROFILE,
  DEFAULT_PROFILE,
  ProfileError,
  ProfileStore,
  activeProfile,
  setActiveProfile,
} from "./profiles.js";
import { SearchIndex } from "./search-index.js";
import { readSettings, writeSettings } from "./settings.js";
import { SkillStore } from "./skills-store.js";
import { Store } from "./store.js";
import { purgeExpiredTrash } from "./trash.js";
import {
  MIGRATIONS_DIR,
  grant,
  tempDatabase,
  tempDir,
} from "./test-helpers.js";
import { WorkspaceStore } from "./workspaces-store.js";

/* Profiles: each one is an isolated set of scopes (profiles design). */

const NOW = "2026-11-14T10:00:00.000Z";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function setup() {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  const db = t.db;
  const profiles = new ProfileStore(db);
  const a = profiles.current();
  const b = profiles.create("Work");
  const to = (id: string) => setActiveProfile(db, id);
  return { t, db, profiles, a, b, to };
}

const agentInput = (name: string): AgentInput => ({
  name,
  description: "",
  prompt: "p",
  toolGrant: grant("allow", []),
  toolApproval: {},
});

describe("migration 0037", () => {
  it("puts every existing record in the Default profile and keeps it", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.pragma("foreign_keys = ON");
    const all = loadMigrations(MIGRATIONS_DIR);
    migrate(
      db,
      all.filter((m) => m.version <= 36),
    );
    const w = tempDir();
    cleanups.push(w.cleanup);
    db.exec(`
      INSERT INTO projects (id, name, created_at, last_used_at) VALUES ('p1', 'P', '${NOW}', '${NOW}');
      INSERT INTO sessions (id, title, created_at, project_id) VALUES ('s1', 'S', '${NOW}', NULL), ('s2', 'S2', '${NOW}', 'p1');
      INSERT INTO files (id, project_id, key, media_type, value, created_at, updated_at)
        VALUES ('f1', NULL, 'a.md', 'text/markdown', 'x', '${NOW}', '${NOW}'),
               ('f2', 'p1', 'a.md', 'text/markdown', 'y', '${NOW}', '${NOW}');
      INSERT INTO folders (project_id, path, created_at) VALUES (NULL, 'notes', '${NOW}');
      INSERT INTO settings (key, value) VALUES ('model', '"m"'), ('port', '4567');
      INSERT INTO mcp_servers (id, name, transport, config, created_at, updated_at)
        VALUES ('m1', 'tools', 'stdio', '{}', '${NOW}', '${NOW}');
      INSERT INTO workspaces (id, name, path, created_at, updated_at)
        VALUES ('w1', 'Notes', '${w.dir}', '${NOW}', '${NOW}');
      INSERT INTO workspace_attachments (workspace_id, owner_kind, owner_id, created_at)
        VALUES ('w1', 'project', 'p1', '${NOW}');
      INSERT INTO workspace_index_files (workspace_id, path, mtime_ms, size) VALUES ('w1', 'a.md', 1, 1);
      INSERT INTO tool_subject_grants (tool, subject_kind, subject_id, created_at)
        VALUES ('workspace_write', 'workspace', 'w1', '${NOW}');
    `);

    expect(migrate(db, all)).toEqual([37]);

    const ids = (table: string) =>
      db.prepare(`SELECT DISTINCT profile_id FROM ${table}`).all();
    for (const table of [
      "projects",
      "sessions",
      "files",
      "folders",
      "settings",
      "mcp_servers",
      "workspaces",
      "tool_subject_grants",
    ]) {
      expect(ids(table), table).toEqual([{ profile_id: DEFAULT_PROFILE }]);
    }
    // Nothing was lost or re-keyed by the rebuilds.
    expect(db.prepare("SELECT key FROM settings ORDER BY key").all()).toEqual([
      { key: "model" },
      { key: "port" },
    ]);
    expect(
      db.prepare("SELECT workspace_id FROM workspace_attachments").all(),
    ).toEqual([{ workspace_id: "w1" }]);
    expect(
      db.prepare("SELECT workspace_id FROM workspace_index_files").all(),
    ).toEqual([{ workspace_id: "w1" }]);
    expect(db.prepare("SELECT id, name FROM profiles").all()).toEqual([
      { id: DEFAULT_PROFILE, name: "Default" },
    ]);
    expect(db.prepare("SELECT value FROM app_state").get()).toEqual({
      value: DEFAULT_PROFILE,
    });
    // Built-ins belong to every profile, so to none in particular.
    expect(
      db
        .prepare(
          "SELECT DISTINCT profile_id FROM agents WHERE builtin = 1 UNION SELECT DISTINCT profile_id FROM skills WHERE builtin = 1 UNION SELECT DISTINCT profile_id FROM schemas WHERE builtin = 1",
        )
        .all(),
    ).toEqual([{ profile_id: BUILTIN_PROFILE }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

describe("ProfileStore", () => {
  it("starts with the Default profile, active", () => {
    const { profiles } = setup();
    expect(profiles.list().map((p) => [p.id, p.name, p.active])).toEqual([
      [DEFAULT_PROFILE, "Default", true],
      [expect.any(String), "Work", false],
    ]);
  });

  it("trims names and keeps them unique among live profiles", () => {
    const { profiles, b } = setup();
    expect(profiles.create("  Home ").name).toBe("Home");
    expect(() => profiles.create("Home")).toThrow(/already exists/);
    expect(() => profiles.create("   ")).toThrow(/needs a name/);
    expect(() => profiles.create("x".repeat(65))).toThrow(/at most 64/);
    expect(() => profiles.rename(b.id, "Home")).toThrow(ProfileError);
    expect(profiles.rename(b.id, "Work").name).toBe("Work");
  });

  it("never trashes the Default or the active profile, and restores by name", () => {
    const { profiles, a, b, to } = setup();
    expect(() => profiles.trash(a.id)).toThrow(/Default/);
    to(b.id);
    expect(() => profiles.trash(b.id)).toThrow(/active/);
    to(a.id);

    profiles.trash(b.id);
    expect(profiles.list().map((p) => p.id)).toEqual([a.id]);
    expect(profiles.list(true).map((p) => p.id)).toEqual([b.id]);

    // The name is free while the profile is in the trash, so it can be taken.
    profiles.create("Work");
    expect(() => profiles.restore(b.id)).toThrow(/already exists/);
  });

  it("remembers the active profile across a restart", () => {
    const { t, db, b, to } = setup();
    to(b.id);
    db.close();
    const reopened = new Database(t.dbPath);
    reopened.pragma("cipher='sqlcipher'");
    reopened.pragma("legacy=4");
    reopened.pragma(`key='${t.key}'`);
    expect(activeProfile(reopened)).toBe(b.id);
    reopened.close();
  });
});

describe("isolation between profiles", () => {
  it("keeps projects and sessions apart, and their ids unreachable", () => {
    const { db, a, b, to } = setup();
    const store = new Store(db);
    store.createProject({ id: "pa", name: "Novel", description: "", now: NOW });
    store.createSession("sa", "In A", NOW, "pa");
    store.createSession("sa2", "Loose A", NOW);

    to(b.id);
    expect(store.listProjects()).toEqual([]);
    expect(store.listSessions(null)).toEqual([]);
    expect(
      store.listSessionsPage({
        projectId: null,
        direction: "desc",
        limit: 10,
        offset: 0,
      }),
    ).toEqual({ items: [], total: 0 });
    expect(store.getProject("pa")).toBeUndefined();
    expect(store.getSession("sa")).toBeUndefined();
    expect(store.countUnread()).toBe(0);

    // The same names are free in another profile.
    store.createProject({ id: "pb", name: "Novel", description: "", now: NOW });
    store.createSession("sb", "In B", NOW, "pb");
    expect(store.listProjects().map((p) => p.id)).toEqual(["pb"]);

    to(a.id);
    expect(store.listProjects().map((p) => p.id)).toEqual(["pa"]);
    expect(store.listSessions("pa").map((s) => s.id)).toEqual(["sa"]);
    expect(store.listSessions(null).map((s) => s.id)).toEqual(["sa2"]);
    expect(store.getSession("sb")).toBeUndefined();
  });

  it("keeps the trash per profile", () => {
    const { db, b, to } = setup();
    const store = new Store(db);
    store.createSession("sa", "A", NOW);
    store.setSessionTrashed("sa", NOW);
    store.createProject({ id: "pa", name: "P", description: "", now: NOW });
    store.trashProject("pa", NOW);
    expect(store.listTrashedSessions()).toHaveLength(1);
    expect(store.listTrashedProjects()).toHaveLength(1);

    to(b.id);
    expect(store.listTrashedSessions()).toEqual([]);
    expect(store.listTrashedProjects()).toEqual([]);
  });

  it("purges expired trash in every profile, not only the active one", () => {
    const { db, b, to } = setup();
    const store = new Store(db);
    store.createSession("old", "Old", "2020-01-01T00:00:00.000Z");
    store.setSessionTrashed("old", "2020-01-02T00:00:00.000Z");
    to(b.id);
    purgeExpiredTrash(store, 30, new Date("2026-11-14T00:00:00Z"));
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'old'").get()).toBe(
      undefined,
    );
  });

  it("keeps global files, folders and project files apart, with the same keys", () => {
    const { db, b, a, to } = setup();
    const store = new Store(db);
    const files = new FileStore(db);
    store.createProject({ id: "pa", name: "P", description: "", now: NOW });
    files.put(null, { key: "notes.md", value: "global A" }, { by: "user" });
    files.put("pa", { key: "notes.md", value: "project A" }, { by: "user" });
    files.createFolder(null, "drafts");

    to(b.id);
    expect(files.list(null)).toEqual([]);
    expect(files.list("pa")).toEqual([]);
    expect(files.listFolders(null)).toEqual([]);
    files.put(null, { key: "notes.md", value: "global B" }, { by: "user" });
    expect(files.get(null, "notes.md")?.value).toBe("global B");

    to(a.id);
    expect(files.get(null, "notes.md")?.value).toBe("global A");
    expect(files.get("pa", "notes.md")?.value).toBe("project A");
    expect(files.listFolders(null)).toEqual(["drafts"]);
  });

  it("keeps agents apart, allows the same name, and still shows built-ins", () => {
    const { db, b, a, to } = setup();
    const agents = new AgentStore(db);
    const editor = agents.create(null, agentInput("Editor"));
    const builtins = agents.builtins().map((x) => x.id);
    expect(builtins).toContain("builtin-dispatcher");

    to(b.id);
    expect(agents.list(null)).toEqual([]);
    expect(agents.get(editor.id)).toBeUndefined();
    const other = agents.create(null, agentInput("Editor"));
    expect(other.id).not.toBe(editor.id);
    expect(agents.pickable(null).map((x) => x.name)).toEqual([
      "Editor",
      ...agents.builtins().map((x) => x.name),
    ]);
    expect(agents.get("builtin-dispatcher")?.builtin).toBe(true);

    to(a.id);
    expect(agents.list(null).map((x) => x.id)).toEqual([editor.id]);
  });

  it("keeps skills apart, and built-in skills are in every profile", () => {
    const { db, b, a, to } = setup();
    const skills = new SkillStore(db);
    const own = skills.create(
      { scope: "global" },
      { name: "outline", description: "d", body: "b" },
    );
    const builtinCount = skills.builtins().length;
    expect(builtinCount).toBeGreaterThan(0);

    to(b.id);
    expect(skills.list({ scope: "global" })).toEqual([]);
    expect(skills.get(own.id)).toBeUndefined();
    expect(skills.builtins()).toHaveLength(builtinCount);
    skills.create(
      { scope: "global" },
      { name: "outline", description: "d", body: "b" },
    );
    expect(skills.list({ scope: "global" })).toHaveLength(1);

    to(a.id);
    expect(skills.list({ scope: "global" }).map((s) => s.id)).toEqual([own.id]);
  });

  it("keeps global schemas and data apart, and built-in schemas in every profile", () => {
    const { db, b, a, to } = setup();
    const data = new DataStore(db, schemaChecker);
    const owner = { projectId: null, agentId: null };
    const shared = data.shared(owner);
    const body = {
      type: "object",
      properties: { n: { type: "string" } },
      required: ["n"],
    };
    shared.createSchema(
      "global",
      { id: "sch-a", name: "Note", description: "d", copiedFrom: null },
      body,
    );
    shared.putData(
      "global",
      {
        id: "d-a",
        schemaId: "sch-a",
        schemaVersion: 1,
        name: "one",
        description: "d",
        value: { n: "x" },
      },
      { by: "user" },
    );
    expect(shared.listSchemas("global")).toHaveLength(1);
    expect(shared.listData("global")).toHaveLength(1);
    const builtins = shared.listSchemas("builtin").length;
    expect(builtins).toBeGreaterThan(0);

    to(b.id);
    expect(shared.listSchemas("global")).toEqual([]);
    expect(shared.listData("global")).toEqual([]);
    expect(shared.getSchema("sch-a")).toBeUndefined();
    expect(shared.getData("d-a")).toBeUndefined();
    expect(shared.nameTaken("global", "Note")).toBe(false);
    // A built-in schema can still be looked up and used.
    expect(shared.listSchemas("builtin")).toHaveLength(builtins);
    expect(shared.getSchema("builtin-task")).toBeDefined();

    to(a.id);
    expect(shared.listSchemas("global").map((s) => s.id)).toEqual(["sch-a"]);
    expect(shared.listData("global").map((d) => d.id)).toEqual(["d-a"]);
  });

  it("keeps settings per profile, with the port shared by all", () => {
    const { db, b, a, to } = setup();
    writeSettings(db, { model: "model-a", systemPrompt: "A", port: 4111 });

    to(b.id);
    expect(readSettings(db, {}).effective.model).toBe("");
    // A new profile starts from the defaults, not from another's settings.
    expect(readSettings(db, {}).effective.systemPrompt).not.toBe("A");
    writeSettings(db, { model: "model-b" });
    expect(readSettings(db, {}).effective.model).toBe("model-b");
    // The port is the app's: written from A, read from B, and the reverse.
    expect(readSettings(db, {}).effective.port).toBe(4111);
    writeSettings(db, { port: 4222 });

    to(a.id);
    expect(readSettings(db, {}).effective.model).toBe("model-a");
    expect(readSettings(db, {}).effective.systemPrompt).toBe("A");
    expect(readSettings(db, {}).effective.port).toBe(4222);
  });

  it("keeps MCP servers apart and lets two profiles use one name", () => {
    const { db, b, a, to } = setup();
    const mcp = new McpServerStore(db);
    const input = {
      name: "tools",
      enabled: true,
      config: { transport: "stdio" as const, command: "x", args: [] },
    };
    const first = mcp.create(input as never);

    to(b.id);
    expect(mcp.list()).toEqual([]);
    expect(mcp.get(first.id)).toBeUndefined();
    const second = mcp.create(input as never);

    to(a.id);
    expect(mcp.list().map((s) => s.id)).toEqual([first.id]);
    expect(second.id).not.toBe(first.id);
  });

  it("keeps workspaces and their 'always allow' grants apart", () => {
    const { db, b, a, to } = setup();
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const folder = join(dir.dir, "notes");
    mkdirSync(folder);
    const workspaces = new WorkspaceStore(db);
    const w = workspaces.create({
      name: "Notes",
      path: folder,
      writable: true,
    });
    workspaces.grantSubject("workspace_write", "workspace", w.id);

    to(b.id);
    expect(workspaces.list()).toEqual([]);
    expect(workspaces.get(w.id)).toBeUndefined();
    expect(
      workspaces.isSubjectGranted("workspace_write", "workspace", w.id),
    ).toBe(false);
    expect(workspaces.grantsFor("workspace")).toEqual([]);
    expect(
      workspaces.create({ name: "Notes", path: folder, writable: false }).id,
    ).not.toBe(w.id);

    to(a.id);
    expect(workspaces.list().map((x) => x.id)).toEqual([w.id]);
    expect(
      workspaces.isSubjectGranted("workspace_write", "workspace", w.id),
    ).toBe(true);
  });

  it("keeps the error log per profile", () => {
    const { db, b, a, to } = setup();
    const store = new Store(db);
    const errors = new ErrorStore(db);
    store.createSession("sa", "A", NOW);
    errors.record(
      {
        sessionId: "sa",
        runId: null,
        source: "run",
        kind: "run_failed",
        message: "boom",
      },
      NOW,
    );
    expect(errors.list()).toHaveLength(1);

    to(b.id);
    expect(errors.list()).toEqual([]);
    expect(errors.filterOptions().sessions).toEqual([]);
    expect(errors.clear()).toBe(0);

    to(a.id);
    expect(errors.list()).toHaveLength(1);
  });

  it("searches only the active profile's global files", () => {
    const { db, b, a, to } = setup();
    const index = new SearchIndex(db);
    const files = new FileStore(db, undefined, undefined, index);
    files.put(
      null,
      { key: "a.md", value: "a lighthouse at dusk" },
      { by: "user" },
    );
    const filter = { sessionId: null, projectId: null, global: true };
    expect(index.keyword(filter, "lighthouse", 10)).toHaveLength(1);

    to(b.id);
    expect(index.keyword(filter, "lighthouse", 10)).toEqual([]);
    files.put(null, { key: "a.md", value: "a harbor at dawn" }, { by: "user" });
    expect(index.keyword(filter, "harbor", 10)).toHaveLength(1);
    // Re-indexing the same key in B did not touch A's chunks.
    to(a.id);
    expect(index.keyword(filter, "lighthouse", 10)).toHaveLength(1);
    expect(index.keyword(filter, "harbor", 10)).toEqual([]);
  });

  it("embeds and drops vectors only for the active profile's chunks", () => {
    const { db, b, a, to } = setup();
    const index = new SearchIndex(db);
    const files = new FileStore(db, undefined, undefined, index);
    files.put(null, { key: "a.md", value: "alpha" }, { by: "user" });
    const [chunkA] = index.pending("old-model", 10);
    index.saveVectors("old-model", [{ id: chunkA?.id ?? 0, vector: [1, 0] }]);

    to(b.id);
    files.put(null, { key: "b.md", value: "beta" }, { by: "user" });
    // Only B's chunk waits, and moving B to a new model leaves A's vectors.
    expect(index.pending("new-model", 10).map((c) => c.key)).toEqual(["b.md"]);
    expect(index.dropOtherModels("new-model")).toBe(0);

    to(a.id);
    expect(index.pending("old-model", 10)).toEqual([]);
  });
});

describe("every row agrees with its owner", () => {
  it("copies the profile from the project or session a row belongs to", () => {
    const { db, b, to } = setup();
    const store = new Store(db);
    const files = new FileStore(db);
    const agents = new AgentStore(db);
    const skills = new SkillStore(db);
    to(b.id);
    store.createProject({ id: "pb", name: "P", description: "", now: NOW });
    store.createSession("sb", "S", NOW, "pb");
    files.put("pb", { key: "a.md", value: "x" }, { by: "user" });
    files.put(null, { key: "g.md", value: "x" }, { by: "user" });
    const agent = agents.create("pb", agentInput("Ed"));
    skills.create(
      { scope: "agent", id: agent.id },
      { name: "s", description: "d", body: "b" },
    );

    const mismatched = (sql: string) => db.prepare(sql).all();
    expect(
      mismatched(
        `SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.profile_id != p.profile_id`,
      ),
    ).toEqual([]);
    expect(
      mismatched(
        `SELECT f.id FROM files f JOIN projects p ON p.id = f.project_id
         WHERE f.profile_id != p.profile_id`,
      ),
    ).toEqual([]);
    expect(
      mismatched(
        `SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id
         WHERE a.profile_id != p.profile_id`,
      ),
    ).toEqual([]);
    expect(
      mismatched(
        `SELECT k.id FROM skills k JOIN agents a ON a.id = k.agent_id
         WHERE k.profile_id != a.profile_id`,
      ),
    ).toEqual([]);
    // Nothing made while B was active landed in Default.
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM files WHERE profile_id = ? AND key IN ('a.md', 'g.md')",
        )
        .get(DEFAULT_PROFILE),
    ).toEqual({ n: 0 });
  });
});
