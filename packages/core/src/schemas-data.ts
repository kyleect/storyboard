import type { DataOp, Message } from "./messages.js";
import type { SchemaNode } from "./schema-features.js";

/*
 * Schemas and data (schemas and data design). A schema is a named JSON
 * Schema with versions; data is a JSON value made from one schema version.
 *
 * - Four scopes (decisions 2, 3). Session schemas and data are rebuilt from
 *   the transcript: tool results and edit messages carry `DataOp`s
 *   (decision 4). Global, project and agent ones live in the backend's
 *   tables, reached through `SharedData`.
 * - Checking against JSON Schema needs Ajv, which runs in the backend only
 *   (plan P3); it reaches this module as a `SchemaChecker`.
 */

export type DataScope = "global" | "project" | "agent" | "session";
export type SharedDataScope = Exclude<DataScope, "session">;
/**
 * Where a schema lives: a data scope, or "builtin" for the schemas that come
 * with the app (decision 45; plan P6). Data never lives in "builtin".
 */
export type SchemaScope = DataScope | "builtin";

/** The longest name (decision 8a). */
export const MAX_DATA_NAME = 64;
/** The longest description (decision 8a). */
export const MAX_DATA_DESCRIPTION = 1024;

/** Thrown for a refused change; the tools return it to the model. */
export class DataError extends Error {
  override name = "DataError";
}

/** Checks JSON Schemas and values (Ajv, in the backend). */
export interface SchemaChecker {
  /** Problems with a schema, as "path: message" lines; empty when valid. */
  checkSchema(body: unknown): string[];
  /** Problems with a value against a schema; empty when it passes. */
  checkData(body: unknown, value: unknown): string[];
}

/** A schema's current state, without its JSON Schema. */
export interface SchemaRecord {
  id: string;
  scope: SchemaScope;
  name: string;
  description: string;
  /** The latest version. */
  version: number;
  copiedFrom: string | null;
  deleted: boolean;
}

/** A piece of data's current state. */
export interface DataRecord {
  id: string;
  scope: DataScope;
  schemaId: string;
  /** The pinned schema version (decision 6). */
  schemaVersion: number;
  name: string;
  description: string;
  value: unknown;
  deleted: boolean;
}

/** Who made a change, for the version history (decision 24). */
export type DataAuthor =
  { by: "user" } | { by: "model"; sessionId: string; runId: string };

/** The result of saving a new schema version (decision 11). */
export interface VersionSaved {
  version: number;
  /** Table data moved to the new version because it passes it. */
  bumped: number;
  /** Table data that fails it and stays on its version. */
  outOfDate: number;
}

/**
 * Global, project and agent schemas and data, implemented by the backend
 * for one run: "project" is the session's project, "agent" the run's
 * agent. Lookups by id find only what is in those scopes.
 */
export interface SharedData {
  /** Live schemas in a scope; deleted ones too with `includeDeleted`. */
  listSchemas(
    scope: SharedDataScope | "builtin",
    includeDeleted?: boolean,
  ): SchemaRecord[];
  /** A schema by id, deleted or not; undefined when not in these scopes. */
  getSchema(id: string): SchemaRecord | undefined;
  /** One version's JSON Schema. */
  schemaBody(id: string, version: number): unknown;
  /** Whether a schema in the scope has the name, deleted ones included. */
  nameTaken(scope: SharedDataScope, name: string, exceptId?: string): boolean;
  createSchema(
    scope: SharedDataScope,
    schema: {
      id: string;
      name: string;
      description: string;
      copiedFrom: string | null;
    },
    body: unknown,
  ): SchemaRecord;
  /** Name and description, in place (decision 10). */
  renameSchema(id: string, name: string, description: string): SchemaRecord;
  /** A new version; table data that passes it is bumped (decision 11). */
  addSchemaVersion(id: string, body: unknown): VersionSaved;
  deleteSchema(id: string): void;
  /** Undoes a delete; its data comes back with it (decision 14). */
  restoreSchema(id: string): void;
  /**
   * Data in a scope whose schema is not deleted: live data, and deleted
   * data too with `includeDeleted`.
   */
  listData(scope: SharedDataScope, includeDeleted?: boolean): DataRecord[];
  /** A piece of data by id, deleted or not; undefined when not in scope. */
  getData(id: string): DataRecord | undefined;
  putData(
    scope: SharedDataScope,
    data: Omit<DataRecord, "scope" | "deleted">,
    author: DataAuthor,
  ): void;
  deleteData(id: string, author: DataAuthor): void;
}

// ---- Merge patch and defaults ---------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Applies a JSON Merge Patch (RFC 7396; decisions 26, 27): a patch that is
 * not an object replaces the value; in an object patch, `null` removes a
 * field and other values merge into it, arrays replaced whole.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const base = isObject(target) ? target : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!(key in patch)) out[key] = value;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null) out[key] = applyMergePatch(base[key], value);
  }
  return out;
}

/**
 * Fills in the schema's defaults where the value has nothing (decision 27):
 * a missing object property with a default gets it; objects present are
 * filled the same way, inside and out. A missing value takes the schema's
 * own default.
 */
export function applyDefaults(node: SchemaNode, value: unknown): unknown {
  if (value === undefined) {
    if (node.default !== undefined) return structuredClone(node.default);
    if (node.type !== "object") return undefined;
  }
  if (node.type !== "object") return value;
  if (value !== undefined && !isObject(value)) return value;
  const out: Record<string, unknown> = { ...(value ?? {}) };
  for (const [name, child] of Object.entries(node.properties)) {
    const filled = applyDefaults(child, out[name]);
    if (filled !== undefined) out[name] = filled;
  }
  return value === undefined && Object.keys(out).length === 0 ? undefined : out;
}

// ---- Session state ----------------------------------------------------------

/** A session schema, with every version's JSON Schema. */
export interface SessionSchema {
  id: string;
  name: string;
  description: string;
  version: number;
  versions: Map<number, unknown>;
  copiedFrom: string | null;
  deleted: boolean;
}

/** Session schemas and data, by id. */
export interface SessionData {
  schemas: Map<string, SessionSchema>;
  data: Map<string, Omit<DataRecord, "scope">>;
}

/** The schema and data changes a message carries, if any. */
export function messageDataOps(message: Message): readonly DataOp[] {
  if (message.role === "edit" || message.role === "tool") {
    return message.dataOps ?? [];
  }
  return [];
}

export function applyDataOp(state: SessionData, op: DataOp): void {
  switch (op.op) {
    case "schema_put": {
      const prev = state.schemas.get(op.id);
      const versions = new Map(prev?.versions ?? []);
      versions.set(op.version, op.body);
      state.schemas.set(op.id, {
        id: op.id,
        name: op.name,
        description: op.description,
        version: op.version,
        versions,
        copiedFrom: op.copiedFrom ?? null,
        deleted: false,
      });
      break;
    }
    case "schema_delete": {
      const prev = state.schemas.get(op.id);
      if (prev) state.schemas.set(op.id, { ...prev, deleted: true });
      break;
    }
    case "data_put":
      state.data.set(op.id, {
        id: op.id,
        schemaId: op.schemaId,
        schemaVersion: op.schemaVersion,
        name: op.name,
        description: op.description,
        value: op.value,
        deleted: false,
      });
      break;
    case "data_delete": {
      const prev = state.data.get(op.id);
      if (prev) state.data.set(op.id, { ...prev, deleted: true });
      break;
    }
  }
}

/** Rebuilds session schemas and data from the transcript (decision 4). */
export function replaySessionData(messages: readonly Message[]): SessionData {
  const state: SessionData = { schemas: new Map(), data: new Map() };
  for (const m of messages) {
    for (const op of messageDataOps(m)) applyDataOp(state, op);
  }
  return state;
}

// ---- What tools see ---------------------------------------------------------

/** A schema as the tools show it. */
export interface SchemaInfo {
  id: string;
  name: string;
  description: string;
  scope: SchemaScope;
  version: number;
  copiedFrom: string | null;
  /** Deleted; listed only when asked for (it can be restored). */
  deleted: boolean;
}

/** A piece of data as `data_list` shows it (decision 29): no value. */
export interface DataInfo {
  id: string;
  name: string;
  description: string;
  scope: DataScope;
  schemaId: string;
  /** The pinned version, after any bump on read (decision 11, plan P8). */
  schemaVersion: number;
  /** The schema's latest version; undefined when it is out of scope. */
  latestVersion: number | undefined;
  /** Pinned to an older version that it does not pass (decision 23). */
  outOfDate: boolean;
  /** False when its schema is not in scope (plan P9): view and delete only. */
  schemaInScope: boolean;
  /** Deleted; listed only when asked for (it can be restored). */
  deleted: boolean;
}

/** A piece of data with its value, and why it is out of date. */
export interface DataView extends DataInfo {
  value: unknown;
  /** Problems against the latest version, when out of date (decision 8). */
  latestErrors: string[];
}

/** A piece of data's editable parts, as an approval prompt compares them. */
export interface DataSnapshot {
  name: string;
  description: string;
  value: unknown;
}

/**
 * A proposed change to one piece of data, worked out but not saved, so the
 * user can approve all or part of it (decisions 31 to 35). Plain data.
 */
export interface DataPlan {
  kind: "create" | "update" | "migrate";
  /** Undefined for a create: the id is made when it is saved. */
  dataId?: string;
  schemaId: string;
  schemaName: string;
  scope: DataScope;
  /** The schema version the result is checked against and pinned to. */
  version: number;
  /** For a migration: the version the data is on now. */
  fromVersion?: number;
  /** Undefined for a create. */
  before?: DataSnapshot;
  after: DataSnapshot;
}

/** A schema's editable parts, as an approval prompt compares them. */
export interface SchemaSnapshot {
  name: string;
  description: string;
  schema: unknown;
}

/** A proposed change to a schema, worked out but not saved. */
export interface SchemaPlan {
  schemaId: string;
  scope: SchemaScope;
  before: SchemaSnapshot;
  after: SchemaSnapshot;
}

/** What tools use to reach schemas and data (`ToolContext.data`). */
export interface DataAccess {
  /** The scopes this run has (decisions 2, 3). */
  readonly scopes: readonly DataScope[];
  /** Deleted ones too with `includeDeleted` (to show and restore them). */
  listSchemas(scope?: SchemaScope, includeDeleted?: boolean): SchemaInfo[];
  /**
   * A live schema in scope, or a deleted one with `includeDeleted`; throws a
   * `DataError` otherwise.
   */
  getSchema(id: string, includeDeleted?: boolean): SchemaInfo;
  /** Every version's JSON Schema, oldest first (decision 10). */
  schemaVersions(id: string): { version: number; body: unknown }[];
  /** Undoes a delete; its data comes back with it (decision 14). */
  restoreSchema(id: string): SchemaInfo;
  /** One version's JSON Schema (the latest when left out). */
  schemaBody(id: string, version?: number): unknown;
  createSchema(input: {
    scope: DataScope;
    name: string;
    description: string;
    body: unknown;
    /** For a copy made elsewhere (decision 12). */
    copiedFrom?: string;
  }): SchemaInfo;
  updateSchema(
    id: string,
    changes: { name?: string; description?: string; body?: unknown },
  ): SchemaInfo & { saved?: VersionSaved };
  copySchema(id: string, scope: DataScope, name?: string): SchemaInfo;
  /** Its data is hidden with it (decision 14). Returns how much. */
  deleteSchema(id: string): { data: number };
  listData(filter?: {
    scope?: DataScope;
    schemaId?: string;
    includeDeleted?: boolean;
  }): DataInfo[];
  /** Where data made from the schema may live (decisions 6, 6a, 6b). */
  dataScopesFor(schemaId: string): DataScope[];
  /**
   * Makes a saved state current again, deleted data included: its name,
   * description and value, on the version it was pinned to (decision 24).
   */
  restoreData(
    id: string,
    state: DataSnapshot & { schemaVersion: number },
  ): DataView;
  /** Deleted data too with `includeDeleted` (to show it and restore it). */
  getData(id: string, includeDeleted?: boolean): DataView;
  createData(input: {
    scope: DataScope;
    schemaId: string;
    name: string;
    description: string;
    value: unknown;
  }): DataView;
  /** Merge patch, checked against the pinned version (decision 26). */
  updateData(
    id: string,
    changes: {
      patch?: unknown;
      /** The whole new value, in place of a patch (the app's forms). */
      value?: unknown;
      name?: string;
      description?: string;
    },
  ): DataView;
  /** Defaults, then the merge patch, checked against the target (27). */
  migrateData(
    id: string,
    toVersion: number | undefined,
    patch: unknown,
  ): DataView;
  deleteData(id: string): void;

  // Plans: work out a change, check a selection of it, then save one.

  /** Throws a `DataError` when the proposal itself is not valid. */
  planCreate(input: {
    scope: DataScope;
    schemaId: string;
    name: string;
    description: string;
    value: unknown;
  }): DataPlan;
  planUpdate(
    id: string,
    changes: {
      patch?: unknown;
      /** The whole new value, in place of a patch (the app's forms). */
      value?: unknown;
      name?: string;
      description?: string;
    },
  ): DataPlan;
  planMigrate(
    id: string,
    toVersion: number | undefined,
    patch: unknown,
    /** The whole new value, in place of defaults and a patch. */
    value?: unknown,
  ): DataPlan;
  /** Problems with saving `snapshot` for the plan; empty when it can be. */
  checkPlan(plan: DataPlan, snapshot: DataSnapshot): string[];
  /** Whether the data changed since the plan was made. */
  planIsStale(plan: DataPlan): boolean;
  /** Saves `snapshot` for the plan; throws a `DataError` if it can't be. */
  commitPlan(plan: DataPlan, snapshot: DataSnapshot): DataView;

  planSchemaUpdate(
    id: string,
    changes: { name?: string; description?: string; body?: unknown },
  ): SchemaPlan;
  checkSchemaPlan(plan: SchemaPlan, snapshot: SchemaSnapshot): string[];
  schemaPlanIsStale(plan: SchemaPlan): boolean;
  commitSchemaPlan(
    plan: SchemaPlan,
    snapshot: SchemaSnapshot,
  ): SchemaInfo & { saved?: VersionSaved };
}

/** The run's agent, for agent scope and project schemas (decision 6b). */
export interface DataAgent {
  id: string;
  /** Set for a project's agent. */
  projectId: string | null;
}

export interface DataAccessOptions {
  /** Session schemas and data; changed in place by writes. */
  session: SessionData;
  /** Session changes are appended here, to be recorded. */
  sessionOps: DataOp[];
  /** Global, project and agent ones. Left out: session scope only. */
  shared?: SharedData;
  checker: SchemaChecker;
  projectId: string | null;
  agent: DataAgent | null;
  author: DataAuthor;
  /** Generates ids. Default: 16 random hex digits. */
  newId?: () => string;
}

const randomId = (): string => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Why a built-in schema can't be changed (decision 45). */
export const BUILTIN_READ_ONLY =
  "Built-in schemas can't be changed. Copy one with schema_copy to make a version you can change.";

const describeScope = (scope: SchemaScope) =>
  scope === "agent" ? "this agent's scope" : `the ${scope} scope`;

/** The `DataAccess` a tool gets for one call. */
export function createDataAccess(options: DataAccessOptions): DataAccess {
  const { session, sessionOps, shared, checker, author } = options;
  const newId = options.newId ?? randomId;
  const scopes: DataScope[] = ["session"];
  if (shared && options.projectId !== null) scopes.push("project");
  if (shared && options.agent) scopes.push("agent");
  if (shared) scopes.push("global");

  const requireScope = (scope: DataScope) => {
    if (scopes.includes(scope)) return;
    throw new DataError(
      scope === "project"
        ? "This conversation is not in a project, so there is no project scope."
        : scope === "agent"
          ? "This conversation has no agent, so there is no agent scope."
          : `The ${scope} scope is not available.`,
    );
  };
  const sessionOp = (op: DataOp) => {
    applyDataOp(session, op);
    sessionOps.push(op);
  };
  const sharedOf = (): SharedData => {
    if (!shared) throw new DataError("Only the session scope is available.");
    return shared;
  };

  // -- Schemas --

  const findSchema = (id: string): SchemaRecord | undefined => {
    const s = session.schemas.get(id);
    if (s) {
      return {
        id: s.id,
        scope: "session",
        name: s.name,
        description: s.description,
        version: s.version,
        copiedFrom: s.copiedFrom,
        deleted: s.deleted,
      };
    }
    return shared?.getSchema(id);
  };
  const liveSchema = (id: string): SchemaRecord => {
    const s = findSchema(id);
    if (!s || s.deleted) {
      throw new DataError(
        `No schema with the id "${id}" is available. Call schemas_list.`,
      );
    }
    return s;
  };
  const bodyOf = (s: SchemaRecord, version: number): unknown => {
    if (s.scope === "session") {
      const body = session.schemas.get(s.id)?.versions.get(version);
      if (body === undefined) {
        throw new DataError(
          `The schema "${s.name}" has no version ${version}; its latest is ${s.version}.`,
        );
      }
      return body;
    }
    if (version < 1 || version > s.version) {
      throw new DataError(
        `The schema "${s.name}" has no version ${version}; its latest is ${s.version}.`,
      );
    }
    return sharedOf().schemaBody(s.id, version);
  };
  const info = (s: SchemaRecord): SchemaInfo => ({
    id: s.id,
    name: s.name,
    description: s.description,
    scope: s.scope,
    version: s.version,
    copiedFrom: s.copiedFrom,
    deleted: s.deleted,
  });

  const checkText = (what: string, value: string, max: number) => {
    const t = value.trim();
    if (t === "") throw new DataError(`The ${what} is required.`);
    if (t.length > max) {
      throw new DataError(`The ${what} is at most ${max} characters.`);
    }
    return t;
  };
  const checkBody = (body: unknown) => {
    const errors = checker.checkSchema(body);
    if (errors.length > 0) {
      throw new DataError(
        `The schema is not valid:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      );
    }
  };
  const nameTaken = (scope: DataScope, name: string, exceptId?: string) =>
    scope === "session"
      ? [...session.schemas.values()].some(
          (s) => s.name === name && s.id !== exceptId,
        )
      : sharedOf().nameTaken(scope, name, exceptId);
  const requireFreeName = (
    scope: DataScope,
    name: string,
    exceptId?: string,
  ) => {
    if (nameTaken(scope, name, exceptId)) {
      throw new DataError(
        `A schema named "${name}" already exists in ${describeScope(scope)}. Pick another name.`,
      );
    }
  };

  const newSchema = (
    scope: DataScope,
    name: string,
    description: string,
    body: unknown,
    copiedFrom: string | null,
  ): SchemaInfo => {
    requireScope(scope);
    requireFreeName(scope, name);
    const id = newId();
    if (scope === "session") {
      sessionOp({
        op: "schema_put",
        id,
        name,
        description,
        version: 1,
        body,
        ...(copiedFrom ? { copiedFrom } : {}),
      });
      return info(liveSchema(id));
    }
    return info(
      sharedOf().createSchema(
        scope,
        { id, name, description, copiedFrom },
        body,
      ),
    );
  };

  // -- Data --

  /** Where data made from a schema in `schemaScope` may live (6, 6a, 6b). */
  const scopesForSchema = (schemaScope: SchemaScope): DataScope[] => {
    const allowed: DataScope[] =
      schemaScope === "global" || schemaScope === "builtin"
        ? ["global", "project", "agent", "session"]
        : schemaScope === "project"
          ? [
              "project",
              "session",
              ...(options.agent?.projectId !== null &&
              options.agent?.projectId === options.projectId
                ? (["agent"] as const)
                : []),
            ]
          : schemaScope === "agent"
            ? ["agent", "session"]
            : ["session"];
    return allowed.filter((s) => scopes.includes(s));
  };

  const findData = (id: string): DataRecord | undefined => {
    const d = session.data.get(id);
    if (d) return { ...d, scope: "session" };
    return shared?.getData(id);
  };

  /** The data's state with the bump on read and out-of-date check (P8). */
  const viewOf = (d: DataRecord): DataView => {
    const schema = findSchema(d.schemaId);
    const base = {
      id: d.id,
      name: d.name,
      description: d.description,
      scope: d.scope,
      schemaId: d.schemaId,
      value: d.value,
      deleted: d.deleted,
    };
    if (!schema || schema.deleted) {
      return {
        ...base,
        schemaVersion: d.schemaVersion,
        latestVersion: undefined,
        outOfDate: false,
        schemaInScope: false,
        latestErrors: [],
      };
    }
    let pinned = d.schemaVersion;
    let latestErrors: string[] = [];
    if (pinned < schema.version) {
      latestErrors = checker.checkData(bodyOf(schema, schema.version), d.value);
      if (latestErrors.length === 0) pinned = schema.version;
    }
    return {
      ...base,
      schemaVersion: pinned,
      latestVersion: schema.version,
      outOfDate: pinned < schema.version,
      schemaInScope: true,
      latestErrors,
    };
  };
  const toInfo = (v: DataView): DataInfo => ({
    id: v.id,
    name: v.name,
    description: v.description,
    scope: v.scope,
    schemaId: v.schemaId,
    schemaVersion: v.schemaVersion,
    latestVersion: v.latestVersion,
    outOfDate: v.outOfDate,
    schemaInScope: v.schemaInScope,
    deleted: v.deleted,
  });

  /** Data that is shown: live, and its schema not deleted (decision 14). */
  const visible = (d: DataRecord): boolean => {
    if (d.deleted) return false;
    const schema = findSchema(d.schemaId);
    return !schema?.deleted;
  };
  const liveData = (id: string): DataRecord => {
    const d = findData(id);
    if (!d || !visible(d)) {
      throw new DataError(
        `No data with the id "${id}" is available. Call data_list.`,
      );
    }
    return d;
  };
  const checkValue = (
    schema: SchemaRecord,
    version: number,
    value: unknown,
  ) => {
    const errors = checker.checkData(bodyOf(schema, version), value);
    if (errors.length > 0) {
      throw new DataError(
        `The value does not match version ${version} of the schema "${schema.name}":\n${errors
          .map((e) => `- ${e}`)
          .join("\n")}`,
      );
    }
  };
  const saveData = (d: Omit<DataRecord, "deleted">) => {
    if (d.scope === "session") {
      sessionOp({
        op: "data_put",
        id: d.id,
        schemaId: d.schemaId,
        schemaVersion: d.schemaVersion,
        name: d.name,
        description: d.description,
        value: d.value,
      });
    } else {
      const { scope, ...rest } = d;
      sharedOf().putData(scope, rest, author);
    }
  };
  const requireUsableSchema = (d: DataRecord): SchemaRecord => {
    const schema = findSchema(d.schemaId);
    if (!schema || schema.deleted) {
      throw new DataError(
        `The data "${d.name}" was made from a schema this conversation cannot use now. It can be viewed and deleted, not changed.`,
      );
    }
    return schema;
  };

  // -- Plans --

  const snapshotOf = (d: DataRecord): DataSnapshot => ({
    name: d.name,
    description: d.description,
    value: d.value,
  });

  /** Problems with the name and description, as text. */
  const textErrors = (snap: { name: string; description: string }) => {
    const out: string[] = [];
    for (const [what, value, max] of [
      ["name", snap.name, MAX_DATA_NAME],
      ["description", snap.description, MAX_DATA_DESCRIPTION],
    ] as const) {
      if (typeof value !== "string" || value.trim() === "") {
        out.push(`The ${what} is required.`);
      } else if (value.trim().length > max) {
        out.push(`The ${what} is at most ${max} characters.`);
      }
    }
    return out;
  };

  const planCreate = (input: {
    scope: DataScope;
    schemaId: string;
    name: string;
    description: string;
    value: unknown;
  }): DataPlan => {
    requireScope(input.scope);
    const schema = liveSchema(input.schemaId);
    const allowed = scopesForSchema(schema.scope);
    if (!allowed.includes(input.scope)) {
      throw new DataError(
        `Data made from the ${schema.scope} schema "${schema.name}" can be saved in: ${allowed.join(", ")}.`,
      );
    }
    const plan: DataPlan = {
      kind: "create",
      schemaId: schema.id,
      schemaName: schema.name,
      scope: input.scope,
      version: schema.version,
      after: {
        name: checkText("name", input.name, MAX_DATA_NAME),
        description: checkText(
          "description",
          input.description,
          MAX_DATA_DESCRIPTION,
        ),
        value: input.value,
      },
    };
    checkValue(schema, plan.version, input.value);
    return plan;
  };

  const planUpdate = (
    id: string,
    changes: {
      patch?: unknown;
      /** The whole new value, in place of a patch (the app's forms). */
      value?: unknown;
      name?: string;
      description?: string;
    },
  ): DataPlan => {
    const d = liveData(id);
    const schema = requireUsableSchema(d);
    const value =
      changes.value !== undefined
        ? changes.value
        : changes.patch !== undefined
          ? applyMergePatch(d.value, changes.patch)
          : d.value;
    // The pinned version, after any bump on read; never changed (26).
    const pinned = viewOf(d).schemaVersion;
    const plan: DataPlan = {
      kind: "update",
      dataId: d.id,
      schemaId: schema.id,
      schemaName: schema.name,
      scope: d.scope,
      version: pinned,
      before: snapshotOf(d),
      after: {
        name:
          changes.name !== undefined
            ? checkText("name", changes.name, MAX_DATA_NAME)
            : d.name,
        description:
          changes.description !== undefined
            ? checkText(
                "description",
                changes.description,
                MAX_DATA_DESCRIPTION,
              )
            : d.description,
        value,
      },
    };
    checkValue(schema, pinned, value);
    return plan;
  };

  const planMigrate = (
    id: string,
    toVersion: number | undefined,
    patch: unknown,
    exact?: unknown,
  ): DataPlan => {
    const d = liveData(id);
    const schema = requireUsableSchema(d);
    const target = toVersion ?? schema.version;
    const pinned = viewOf(d).schemaVersion;
    if (target <= pinned) {
      throw new DataError(
        `The data "${d.name}" is on version ${pinned}; migrate it to a newer one (the latest is ${schema.version}).`,
      );
    }
    const body = bodyOf(schema, target) as SchemaNode;
    const filled = applyDefaults(body, d.value);
    const value =
      exact !== undefined
        ? exact
        : patch !== undefined
          ? applyMergePatch(filled, patch)
          : filled;
    checkValue(schema, target, value);
    return {
      kind: "migrate",
      dataId: d.id,
      schemaId: schema.id,
      schemaName: schema.name,
      scope: d.scope,
      version: target,
      fromVersion: pinned,
      before: snapshotOf(d),
      after: { name: d.name, description: d.description, value },
    };
  };

  const checkPlan = (plan: DataPlan, snap: DataSnapshot): string[] => {
    const schema = findSchema(plan.schemaId);
    if (!schema || schema.deleted) {
      return [`The schema "${plan.schemaName}" is no longer available.`];
    }
    if (snap.value === undefined) return ["The value is required."];
    return [
      ...textErrors(snap),
      ...checker.checkData(bodyOf(schema, plan.version), snap.value),
    ];
  };

  const commitPlan = (plan: DataPlan, snap: DataSnapshot): DataView => {
    const errors = checkPlan(plan, snap);
    if (errors.length > 0) {
      throw new DataError(
        `It cannot be saved:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    const id = plan.dataId ?? newId();
    saveData({
      id,
      scope: plan.scope,
      schemaId: plan.schemaId,
      schemaVersion: plan.version,
      name: snap.name.trim(),
      description: snap.description.trim(),
      value: snap.value,
    });
    return viewOf(liveData(id));
  };

  const schemaSnapshot = (s: SchemaRecord): SchemaSnapshot => ({
    name: s.name,
    description: s.description,
    schema: bodyOf(s, s.version),
  });

  const planSchemaUpdate = (
    id: string,
    changes: { name?: string; description?: string; body?: unknown },
  ): SchemaPlan => {
    const s = liveSchema(id);
    if (s.scope === "builtin") throw new DataError(BUILTIN_READ_ONLY);
    const before = schemaSnapshot(s);
    const plan: SchemaPlan = {
      schemaId: s.id,
      scope: s.scope,
      before,
      after: {
        name:
          changes.name !== undefined
            ? checkText("name", changes.name, MAX_DATA_NAME)
            : s.name,
        description:
          changes.description !== undefined
            ? checkText(
                "description",
                changes.description,
                MAX_DATA_DESCRIPTION,
              )
            : s.description,
        schema: changes.body ?? before.schema,
      },
    };
    const errors = checkSchemaPlan(plan, plan.after);
    if (errors.length > 0) {
      throw new DataError(errors.join("\n"));
    }
    return plan;
  };

  const checkSchemaPlan = (
    plan: SchemaPlan,
    snap: SchemaSnapshot,
  ): string[] => {
    if (plan.scope === "builtin") return [BUILTIN_READ_ONLY];
    const errors = textErrors(snap);
    if (
      typeof snap.name === "string" &&
      snap.name.trim() !== plan.before.name &&
      nameTaken(plan.scope, snap.name.trim(), plan.schemaId)
    ) {
      errors.push(
        `A schema named "${snap.name.trim()}" already exists in ${describeScope(plan.scope)}.`,
      );
    }
    const schemaErrors = checker.checkSchema(snap.schema);
    if (schemaErrors.length > 0) {
      errors.push(
        `The schema is not valid:\n${schemaErrors.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    return errors;
  };

  const commitSchemaPlan = (
    plan: SchemaPlan,
    snap: SchemaSnapshot,
  ): SchemaInfo & { saved?: VersionSaved } => {
    const errors = checkSchemaPlan(plan, snap);
    if (errors.length > 0) throw new DataError(errors.join("\n"));
    const s = liveSchema(plan.schemaId);
    const name = snap.name.trim();
    const description = snap.description.trim();
    // Only a change to the JSON Schema makes a new version (decision 10).
    const latest = bodyOf(s, s.version);
    const newBody =
      JSON.stringify(snap.schema) !== JSON.stringify(latest)
        ? snap.schema
        : undefined;
    if (s.scope === "session") {
      sessionOp({
        op: "schema_put",
        id: s.id,
        name,
        description,
        version: newBody !== undefined ? s.version + 1 : s.version,
        body: newBody ?? latest,
        ...(s.copiedFrom ? { copiedFrom: s.copiedFrom } : {}),
      });
      return info(liveSchema(s.id));
    }
    const store = sharedOf();
    if (name !== s.name || description !== s.description) {
      store.renameSchema(s.id, name, description);
    }
    const saved =
      newBody !== undefined ? store.addSchemaVersion(s.id, newBody) : undefined;
    return { ...info(liveSchema(s.id)), ...(saved ? { saved } : {}) };
  };

  const listData = (
    filter: {
      scope?: DataScope;
      schemaId?: string;
      includeDeleted?: boolean;
    } = {},
  ): DataInfo[] => {
    if (filter.scope !== undefined) requireScope(filter.scope);
    const wanted = filter.scope === undefined ? scopes : [filter.scope];
    const withDeleted = filter.includeDeleted === true;
    const out: DataInfo[] = [];
    for (const s of wanted) {
      const records: DataRecord[] =
        s === "session"
          ? [...session.data.values()].map((d) => ({ ...d, scope: s }))
          : sharedOf().listData(s, withDeleted);
      for (const d of records) {
        // Data is hidden while its schema is deleted (decision 14).
        if (findSchema(d.schemaId)?.deleted) continue;
        if (d.deleted && !withDeleted) continue;
        if (filter.schemaId !== undefined && d.schemaId !== filter.schemaId)
          continue;
        out.push(toInfo(viewOf(d)));
      }
    }
    return out;
  };

  return {
    scopes,

    listSchemas(scope, includeDeleted = false) {
      if (scope === "builtin") sharedOf();
      else if (scope !== undefined) requireScope(scope);
      // Built-in schemas are always in scope, listed first (plan P7).
      const wanted: SchemaScope[] =
        scope !== undefined
          ? [scope]
          : shared
            ? ["builtin", ...scopes]
            : scopes;
      const out: SchemaInfo[] = [];
      for (const s of wanted) {
        if (s === "session") {
          for (const x of session.schemas.values()) {
            const r = findSchema(x.id);
            if (r && (includeDeleted || !r.deleted)) out.push(info(r));
          }
        } else {
          out.push(...sharedOf().listSchemas(s, includeDeleted).map(info));
        }
      }
      return out;
    },

    getSchema: (id, includeDeleted = false) => {
      if (!includeDeleted) return info(liveSchema(id));
      const s = findSchema(id);
      if (!s) {
        throw new DataError(
          `No schema with the id "${id}" is available. Call schemas_list.`,
        );
      }
      return info(s);
    },

    schemaVersions(id) {
      const s = findSchema(id);
      if (!s) {
        throw new DataError(`No schema with the id "${id}" is available.`);
      }
      return Array.from({ length: s.version }, (_, i) => ({
        version: i + 1,
        body: bodyOf(s, i + 1),
      }));
    },

    restoreSchema(id) {
      const s = findSchema(id);
      if (!s) {
        throw new DataError(`No schema with the id "${id}" is available.`);
      }
      if (s.scope === "builtin") throw new DataError(BUILTIN_READ_ONLY);
      if (!s.deleted) return info(s);
      if (s.scope === "session") {
        sessionOp({
          op: "schema_put",
          id: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
          body: bodyOf(s, s.version),
          ...(s.copiedFrom ? { copiedFrom: s.copiedFrom } : {}),
        });
      } else {
        sharedOf().restoreSchema(id);
      }
      return info(liveSchema(id));
    },

    schemaBody(id, version) {
      const s = liveSchema(id);
      return bodyOf(s, version ?? s.version);
    },

    createSchema(input) {
      const name = checkText("name", input.name, MAX_DATA_NAME);
      const description = checkText(
        "description",
        input.description,
        MAX_DATA_DESCRIPTION,
      );
      checkBody(input.body);
      return newSchema(
        input.scope,
        name,
        description,
        input.body,
        input.copiedFrom ?? null,
      );
    },

    updateSchema(id, changes) {
      const plan = planSchemaUpdate(id, changes);
      return commitSchemaPlan(plan, plan.after);
    },

    planSchemaUpdate,
    checkSchemaPlan,
    schemaPlanIsStale: (plan) =>
      JSON.stringify(schemaSnapshot(liveSchema(plan.schemaId))) !==
      JSON.stringify(plan.before),
    commitSchemaPlan,

    copySchema(id, scope, name) {
      const s = liveSchema(id);
      const newName =
        name !== undefined ? checkText("name", name, MAX_DATA_NAME) : s.name;
      return newSchema(
        scope,
        newName,
        s.description,
        bodyOf(s, s.version),
        s.id,
      );
    },

    deleteSchema(id) {
      const s = liveSchema(id);
      if (s.scope === "builtin") throw new DataError(BUILTIN_READ_ONLY);
      const count = listData({ schemaId: id }).length;
      if (s.scope === "session") sessionOp({ op: "schema_delete", id });
      else sharedOf().deleteSchema(id);
      return { data: count };
    },

    listData,

    dataScopesFor: (schemaId) => scopesForSchema(liveSchema(schemaId).scope),

    restoreData(id, state) {
      const d = findData(id);
      if (!d || findSchema(d.schemaId)?.deleted) {
        throw new DataError(`No data with the id "${id}" is available.`);
      }
      const schema = requireUsableSchema(d);
      const name = checkText("name", state.name, MAX_DATA_NAME);
      const description = checkText(
        "description",
        state.description,
        MAX_DATA_DESCRIPTION,
      );
      checkValue(schema, state.schemaVersion, state.value);
      saveData({
        id: d.id,
        scope: d.scope,
        schemaId: d.schemaId,
        schemaVersion: state.schemaVersion,
        name,
        description,
        value: state.value,
      });
      return viewOf(liveData(id));
    },

    getData: (id, includeDeleted = false) => {
      if (!includeDeleted) return viewOf(liveData(id));
      const d = findData(id);
      if (!d || findSchema(d.schemaId)?.deleted) {
        throw new DataError(
          `No data with the id "${id}" is available. Call data_list.`,
        );
      }
      return viewOf(d);
    },

    createData(input) {
      const plan = planCreate(input);
      return commitPlan(plan, plan.after);
    },

    updateData(id, changes) {
      const plan = planUpdate(id, changes);
      return commitPlan(plan, plan.after);
    },

    migrateData(id, toVersion, patch) {
      const plan = planMigrate(id, toVersion, patch);
      return commitPlan(plan, plan.after);
    },

    planCreate,
    planUpdate,
    planMigrate,
    checkPlan,
    planIsStale: (plan) => {
      if (plan.dataId === undefined) return false;
      const d = findData(plan.dataId);
      return (
        !d ||
        !visible(d) ||
        JSON.stringify(snapshotOf(d)) !== JSON.stringify(plan.before)
      );
    },
    commitPlan,

    deleteData(id) {
      const d = liveData(id);
      if (d.scope === "session") sessionOp({ op: "data_delete", id });
      else sharedOf().deleteData(id, author);
    },
  };
}

/** The notice the model reads for an edit message with these changes. */
export function dataEditNotice(ops: readonly DataOp[]): string {
  const parts = ops.map((op) => {
    switch (op.op) {
      case "schema_put":
        return `changed session schema "${op.name}" (id ${op.id})`;
      case "schema_delete":
        return `deleted session schema ${op.id}`;
      case "data_put":
        return `changed session data "${op.name}" (id ${op.id})`;
      case "data_delete":
        return `deleted session data ${op.id}`;
    }
  });
  return `[The user ${parts.join("; ")} in the app.]`;
}

const noData = (): never => {
  throw new DataError("Schemas and data are not available in this run.");
};

/** What a tool gets for schemas and data when the run has none. */
export const NO_DATA: DataAccess = {
  scopes: [],
  listSchemas: noData,
  getSchema: noData,
  schemaBody: noData,
  createSchema: noData,
  updateSchema: noData,
  copySchema: noData,
  deleteSchema: noData,
  listData: noData,
  getData: noData,
  createData: noData,
  updateData: noData,
  migrateData: noData,
  deleteData: noData,
  dataScopesFor: noData,
  restoreData: noData,
  schemaVersions: noData,
  restoreSchema: noData,
  planCreate: noData,
  planUpdate: noData,
  planMigrate: noData,
  checkPlan: noData,
  planIsStale: noData,
  commitPlan: noData,
  planSchemaUpdate: noData,
  checkSchemaPlan: noData,
  schemaPlanIsStale: noData,
  commitSchemaPlan: noData,
};
