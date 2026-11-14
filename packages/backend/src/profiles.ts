import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3-multiple-ciphers";

/*
 * Profiles (profiles design). A profile is one isolated workspace: its own
 * global, project, agent and session scopes, settings, MCP servers,
 * workspaces, tool grants and error log. One profile is active at a time, for
 * the whole backend, so every open window shows the same one.
 *
 * The active profile is kept per database handle and read by the stores on
 * every query (design 4.2). That keeps the stores' constructors as they were:
 * a store that knows its `db` knows its profile.
 */

/** The profile every existing record belongs to after migration 0037. */
export const DEFAULT_PROFILE = "default";

/**
 * The owner of built-in agents, skills and schemas. They are shared by every
 * profile and found by `builtin = 1`, so a query for a profile's own records
 * never returns them (design decision 6).
 */
export const BUILTIN_PROFILE = "builtin";

/** What a profile name may be: trimmed, not empty, at most 64 characters. */
const MAX_NAME = 64;

export class ProfileError extends Error {
  override name = "ProfileError";
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const active = new WeakMap<Database, string>();

/** The id of the active profile of this database. */
export function activeProfile(db: Database): string {
  const known = active.get(db);
  if (known !== undefined) return known;
  const row = db
    .prepare("SELECT value FROM app_state WHERE key = 'activeProfile'")
    .get() as { value: string } | undefined;
  const id = row?.value ?? DEFAULT_PROFILE;
  active.set(db, id);
  return id;
}

/** Makes `id` the active profile and remembers it across restarts. */
export function setActiveProfile(db: Database, id: string) {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES ('activeProfile', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(id);
  active.set(db, id);
}

export interface ProfileRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  /** Null: not in the trash. */
  trashedAt: string | null;
  /** True for the profile the backend is using now. */
  active: boolean;
}

interface Raw {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string;
  trashed_at: string | null;
}

export class ProfileStore {
  constructor(
    readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  private view(r: Raw): ProfileRow {
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      trashedAt: r.trashed_at,
      active: r.id === activeProfile(this.db),
    };
  }

  /** Profiles not in the trash, or only those in it. Oldest first. */
  list(trashed = false): ProfileRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM profiles WHERE (trashed_at IS NOT NULL) = ?
         ORDER BY created_at, id`,
      )
      .all(trashed ? 1 : 0) as Raw[];
    return rows.map((r) => this.view(r));
  }

  get(id: string): ProfileRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(id) as Raw | undefined;
    return row ? this.view(row) : undefined;
  }

  /** The active profile. It always exists: the migration makes "default". */
  current(): ProfileRow {
    const row = this.get(activeProfile(this.db));
    if (!row) {
      throw new ProfileError("The active profile does not exist.", 404);
    }
    return row;
  }

  private checkName(name: string, exceptId?: string): string {
    const trimmed = name.trim();
    if (trimmed === "") {
      throw new ProfileError("A profile needs a name.", 400);
    }
    if (trimmed.length > MAX_NAME) {
      throw new ProfileError(
        `A profile name is at most ${MAX_NAME} characters.`,
        400,
      );
    }
    const clash = this.db
      .prepare(
        "SELECT id FROM profiles WHERE name = ? AND trashed_at IS NULL AND id != ?",
      )
      .get(trimmed, exceptId ?? "") as { id: string } | undefined;
    if (clash) {
      throw new ProfileError(
        `A profile named "${trimmed}" already exists.`,
        409,
      );
    }
    return trimmed;
  }

  create(name: string): ProfileRow {
    const trimmed = this.checkName(name);
    const id = this.newId();
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO profiles (id, name, created_at, last_used_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, trimmed, now, now);
    return this.require(id);
  }

  rename(id: string, name: string): ProfileRow {
    this.require(id);
    const trimmed = this.checkName(name, id);
    this.db
      .prepare("UPDATE profiles SET name = ? WHERE id = ?")
      .run(trimmed, id);
    return this.require(id);
  }

  /** Moves a profile to the trash. Its data is kept (design non-goals). */
  trash(id: string): ProfileRow {
    const profile = this.require(id);
    if (profile.trashedAt !== null) return profile;
    if (id === DEFAULT_PROFILE) {
      throw new ProfileError("The Default profile cannot be trashed.", 409);
    }
    if (profile.active) {
      throw new ProfileError(
        "The active profile cannot be trashed. Switch to another first.",
        409,
      );
    }
    this.db
      .prepare("UPDATE profiles SET trashed_at = ? WHERE id = ?")
      .run(this.now(), id);
    return this.require(id);
  }

  /** Brings a profile back. Its name must still be free. */
  restore(id: string): ProfileRow {
    const profile = this.require(id);
    if (profile.trashedAt === null) return profile;
    this.checkName(profile.name, id);
    this.db
      .prepare("UPDATE profiles SET trashed_at = NULL WHERE id = ?")
      .run(id);
    return this.require(id);
  }

  /** Records that the profile was switched to. */
  touch(id: string) {
    this.db
      .prepare("UPDATE profiles SET last_used_at = ? WHERE id = ?")
      .run(this.now(), id);
  }

  require(id: string): ProfileRow {
    const row = this.get(id);
    if (!row) throw new ProfileError("Profile not found.", 404);
    return row;
  }
}
