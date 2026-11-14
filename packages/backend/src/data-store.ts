import type { Database } from "better-sqlite3-multiple-ciphers";
import { activeProfile } from "./profiles.js";
import type {
  DataAuthor,
  DataRecord,
  SchemaChecker,
  SchemaRecord,
  SharedData,
  SharedDataScope,
  VersionSaved,
} from "@harness/core";

/*
 * Global, project and agent schemas and data (schemas and data design).
 * Session ones are rebuilt from the transcript and are not here (decision
 * 4). A schema's versions are its JSON Schemas (decision 10); data keeps
 * every saved state (decision 24). A deleted schema hides its data, and
 * restoring it brings the data back (decision 14). An agent's schemas and
 * data are in scope only while the agent can be picked, so they go and come
 * back with it (decision 7). Purging a project removes its own and those of
 * its agents (`Store.purgeProject`).
 */

/** One saved state of a piece of data (decision 24). */
export interface DataVersion {
  seq: number;
  schemaVersion: number;
  name: string;
  description: string;
  value: unknown;
  /** A deletion; the content is what the data had then. */
  deleted: boolean;
  author: "user" | "model";
  /** For the model: the session that made the change, if not purged. */
  sessionId: string | null;
  createdAt: string;
}

/** The scopes one run reaches: the session's project and the run's agent. */
export interface DataOwner {
  projectId: string | null;
  agentId: string | null;
}

interface SchemaRow {
  id: string;
  /** 1: a built-in schema (decision 45). */
  builtin: number;
  project_id: string | null;
  agent_id: string | null;
  name: string;
  description: string;
  version: number;
  copied_from: string | null;
  deleted_at: string | null;
}

interface DataRow {
  id: string;
  project_id: string | null;
  agent_id: string | null;
  schema_id: string;
  schema_version: number;
  name: string;
  description: string;
  value: string;
  deleted_at: string | null;
}

const scopeOf = (r: {
  project_id: string | null;
  agent_id: string | null;
}): SharedDataScope =>
  r.agent_id !== null ? "agent" : r.project_id !== null ? "project" : "global";

const toSchema = (r: SchemaRow): SchemaRecord => ({
  id: r.id,
  scope: r.builtin === 1 ? "builtin" : scopeOf(r),
  name: r.name,
  description: r.description,
  version: r.version,
  copiedFrom: r.copied_from,
  deleted: r.deleted_at !== null,
});

const toData = (r: DataRow): DataRecord => ({
  id: r.id,
  scope: scopeOf(r),
  schemaId: r.schema_id,
  schemaVersion: r.schema_version,
  name: r.name,
  description: r.description,
  value: JSON.parse(r.value) as unknown,
  deleted: r.deleted_at !== null,
});

const SCHEMA_COLUMNS =
  "id, project_id, agent_id, name, description, version, copied_from, deleted_at, builtin";
const DATA_COLUMNS =
  "id, project_id, agent_id, schema_id, schema_version, name, description, value, deleted_at";

export class DataStore {
  constructor(
    private readonly db: Database,
    private readonly checker: SchemaChecker,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** The `SharedData` for a run with this project and agent. */
  shared(owner: DataOwner): SharedData {
    const db = this.db;
    const now = this.now;
    const checker = this.checker;

    /**
     * Columns for a scope that this run reaches, in the active profile
     * (profiles design 4.1: every row carries its profile).
     */
    const where = (scope: SharedDataScope): [string, unknown[]] => {
      const profile = activeProfile(db);
      switch (scope) {
        case "global":
          return [
            "project_id IS NULL AND agent_id IS NULL AND profile_id = ?",
            [profile],
          ];
        case "project":
          if (owner.projectId === null) return ["0", []];
          return [
            "project_id = ? AND agent_id IS NULL AND profile_id = ?",
            [owner.projectId, profile],
          ];
        case "agent":
          if (owner.agentId === null) return ["0", []];
          return ["agent_id = ? AND profile_id = ?", [owner.agentId, profile]];
      }
    };
    /**
     * `where` for schemas: built-in ones are a scope of their own (plan P6),
     * so the global scope leaves them out.
     */
    const schemaWhere = (
      scope: SharedDataScope | "builtin",
    ): [string, unknown[]] => {
      if (scope === "builtin") return ["builtin = 1", []];
      const [sql, args] = where(scope);
      return [`(${sql}) AND builtin = 0`, args];
    };
    const owners = (scope: SharedDataScope) => ({
      project: scope === "project" ? owner.projectId : null,
      agent: scope === "agent" ? owner.agentId : null,
    });
    /** Any scope this run reaches. */
    const reachable = (): [string, unknown[]] => {
      const parts = (["global", "project", "agent"] as const).map(where);
      return [
        parts.map(([sql]) => `(${sql})`).join(" OR "),
        parts.flatMap(([, args]) => args),
      ];
    };

    const schemaRow = (id: string): SchemaRow | undefined => {
      const [sql, args] = reachable();
      // The built-in schemas belong to no profile and every run reaches them.
      return db
        .prepare(
          `SELECT ${SCHEMA_COLUMNS} FROM schemas WHERE id = ? AND ((${sql}) OR builtin = 1)`,
        )
        .get(id, ...args) as SchemaRow | undefined;
    };
    const requireSchema = (id: string): SchemaRow => {
      const row = schemaRow(id);
      if (!row) throw new Error(`No schema "${id}" in this run's scopes.`);
      return row;
    };
    const dataRow = (id: string): DataRow | undefined => {
      const [sql, args] = reachable();
      return db
        .prepare(`SELECT ${DATA_COLUMNS} FROM data WHERE id = ? AND (${sql})`)
        .get(id, ...args) as DataRow | undefined;
    };
    const addVersion = (
      id: string,
      d: {
        schemaVersion: number;
        name: string;
        description: string;
        value: unknown;
      },
      deleted: boolean,
      author: DataAuthor,
      time: string,
    ) => {
      const { seq } = db
        .prepare(
          "SELECT coalesce(max(seq), 0) + 1 AS seq FROM data_versions WHERE data_id = ?",
        )
        .get(id) as { seq: number };
      db.prepare(
        `INSERT INTO data_versions (data_id, seq, schema_version, name, description, value, deleted, author, session_id, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        seq,
        d.schemaVersion,
        d.name,
        d.description,
        JSON.stringify(d.value),
        deleted ? 1 : 0,
        author.by,
        author.by === "model" ? author.sessionId : null,
        author.by === "model" ? author.runId : null,
        time,
      );
    };

    return {
      listSchemas(scope, includeDeleted = false) {
        const [sql, args] = schemaWhere(scope);
        return (
          db
            .prepare(
              `SELECT ${SCHEMA_COLUMNS} FROM schemas WHERE (${sql}) AND (${includeDeleted ? 1 : 0} OR deleted_at IS NULL) ORDER BY name`,
            )
            .all(...args) as SchemaRow[]
        ).map(toSchema);
      },

      getSchema(id) {
        const row = schemaRow(id);
        return row ? toSchema(row) : undefined;
      },

      schemaBody(id, version) {
        const row = db
          .prepare(
            "SELECT body FROM schema_versions WHERE schema_id = ? AND version = ?",
          )
          .get(id, version) as { body: string } | undefined;
        if (!row) throw new Error(`Schema "${id}" has no version ${version}.`);
        return JSON.parse(row.body) as unknown;
      },

      nameTaken(scope, name, exceptId) {
        const [sql, args] = schemaWhere(scope);
        return (
          db
            .prepare(
              `SELECT 1 FROM schemas WHERE (${sql}) AND name = ? AND id IS NOT ?`,
            )
            .get(...args, name, exceptId ?? null) !== undefined
        );
      },

      createSchema(scope, schema, body) {
        const time = now();
        const { project, agent } = owners(scope);
        db.transaction(() => {
          db.prepare(
            `INSERT INTO schemas (id, profile_id, project_id, agent_id, name, description, version, copied_from, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          ).run(
            schema.id,
            activeProfile(db),
            project,
            agent,
            schema.name,
            schema.description,
            schema.copiedFrom,
            time,
            time,
          );
          db.prepare(
            "INSERT INTO schema_versions (schema_id, version, body, created_at) VALUES (?, 1, ?, ?)",
          ).run(schema.id, JSON.stringify(body), time);
        })();
        return toSchema(requireSchema(schema.id));
      },

      renameSchema(id, name, description) {
        requireSchema(id);
        db.prepare(
          "UPDATE schemas SET name = ?, description = ?, updated_at = ? WHERE id = ?",
        ).run(name, description, now(), id);
        return toSchema(requireSchema(id));
      },

      addSchemaVersion(id, body): VersionSaved {
        const row = requireSchema(id);
        const version = row.version + 1;
        const time = now();
        let bumped = 0;
        let outOfDate = 0;
        db.transaction(() => {
          db.prepare(
            "INSERT INTO schema_versions (schema_id, version, body, created_at) VALUES (?, ?, ?, ?)",
          ).run(id, version, JSON.stringify(body), time);
          db.prepare(
            "UPDATE schemas SET version = ?, updated_at = ? WHERE id = ?",
          ).run(version, time, id);
          // Data that passes the new version moves to it; the rest stays
          // out of date (decision 11). Every scope's data of this schema.
          const rows = db
            .prepare(
              "SELECT id, value FROM data WHERE schema_id = ? AND deleted_at IS NULL",
            )
            .all(id) as { id: string; value: string }[];
          const bump = db.prepare(
            "UPDATE data SET schema_version = ? WHERE id = ?",
          );
          for (const r of rows) {
            if (checker.checkData(body, JSON.parse(r.value)).length === 0) {
              bump.run(version, r.id);
              bumped++;
            } else {
              outOfDate++;
            }
          }
        })();
        return { version, bumped, outOfDate };
      },

      deleteSchema(id) {
        requireSchema(id);
        const time = now();
        db.prepare(
          "UPDATE schemas SET deleted_at = ?, updated_at = ? WHERE id = ?",
        ).run(time, time, id);
      },

      restoreSchema(id) {
        requireSchema(id);
        db.prepare(
          "UPDATE schemas SET deleted_at = NULL, updated_at = ? WHERE id = ?",
        ).run(now(), id);
      },

      listData(scope, includeDeleted = false) {
        const [sql, args] = where(scope);
        const qualified = sql
          .replaceAll("project_id", "d.project_id")
          .replaceAll("agent_id", "d.agent_id")
          .replaceAll("profile_id", "d.profile_id");
        return (
          db
            .prepare(
              `SELECT ${DATA_COLUMNS.split(", ")
                .map((c) => `d.${c}`)
                .join(", ")}
               FROM data d JOIN schemas s ON s.id = d.schema_id
               WHERE (${qualified}) AND s.deleted_at IS NULL
                 AND (${includeDeleted ? 1 : 0} OR d.deleted_at IS NULL)
               ORDER BY d.name`,
            )
            .all(...args) as DataRow[]
        ).map(toData);
      },

      getData(id) {
        const row = dataRow(id);
        return row ? toData(row) : undefined;
      },

      putData(scope, d, author) {
        const time = now();
        const { project, agent } = owners(scope);
        db.transaction(() => {
          const existing = dataRow(d.id);
          if (existing) {
            db.prepare(
              `UPDATE data SET schema_version = ?, name = ?, description = ?, value = ?, updated_at = ?, deleted_at = NULL
               WHERE id = ?`,
            ).run(
              d.schemaVersion,
              d.name,
              d.description,
              JSON.stringify(d.value),
              time,
              d.id,
            );
          } else {
            db.prepare(
              `INSERT INTO data (id, profile_id, project_id, agent_id, schema_id, schema_version, name, description, value, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              d.id,
              activeProfile(db),
              project,
              agent,
              d.schemaId,
              d.schemaVersion,
              d.name,
              d.description,
              JSON.stringify(d.value),
              time,
              time,
            );
          }
          addVersion(d.id, d, false, author, time);
        })();
      },

      deleteData(id, author) {
        const row = dataRow(id);
        if (!row) throw new Error(`No data "${id}" in this run's scopes.`);
        const time = now();
        db.transaction(() => {
          db.prepare(
            "UPDATE data SET deleted_at = ?, updated_at = ? WHERE id = ?",
          ).run(time, time, id);
          addVersion(
            id,
            {
              schemaVersion: row.schema_version,
              name: row.name,
              description: row.description,
              value: JSON.parse(row.value),
            },
            true,
            author,
            time,
          );
        })();
      },
    };
  }

  /** A piece of data's saved states, oldest first (decision 24). */
  versions(dataId: string): DataVersion[] {
    return (
      this.db
        .prepare(
          `SELECT seq, schema_version, name, description, value, deleted, author, session_id, created_at
           FROM data_versions WHERE data_id = ? ORDER BY seq`,
        )
        .all(dataId) as {
        seq: number;
        schema_version: number;
        name: string;
        description: string;
        value: string;
        deleted: number;
        author: "user" | "model";
        session_id: string | null;
        created_at: string;
      }[]
    ).map((r) => ({
      seq: r.seq,
      schemaVersion: r.schema_version,
      name: r.name,
      description: r.description,
      value: JSON.parse(r.value) as unknown,
      deleted: r.deleted === 1,
      author: r.author,
      sessionId: r.session_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * Schemas in scope for a run, for the system message (decision 37):
   * global, the project's and the agent's, live ones only.
   */
  inScope(owner: DataOwner): SchemaRecord[] {
    const shared = this.shared(owner);
    return [
      ...shared.listSchemas("builtin"),
      ...shared.listSchemas("global"),
      ...(owner.projectId !== null ? shared.listSchemas("project") : []),
      ...(owner.agentId !== null ? shared.listSchemas("agent") : []),
    ];
  }

  /**
   * Data in scope for a run, for the system message: global, the project's
   * and the agent's, live ones only, whose schema is live too.
   */
  dataInScope(owner: DataOwner): DataRecord[] {
    const shared = this.shared(owner);
    return [
      ...shared.listData("global"),
      ...(owner.projectId !== null ? shared.listData("project") : []),
      ...(owner.agentId !== null ? shared.listData("agent") : []),
    ];
  }
}
