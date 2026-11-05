import { describe, expect, it } from "vitest";
import type { DataOp, Message } from "./messages.js";
import { checkSchemaFeatures, type SchemaNode } from "./schema-features.js";
import {
  applyDefaults,
  applyMergePatch,
  createDataAccess,
  DataError,
  replaySessionData,
  type DataAgent,
  type SchemaChecker,
  type SessionData,
} from "./schemas-data.js";

/** A small stand-in for Ajv: types, required properties, enums, items. */
function check(node: SchemaNode, value: unknown, path = ""): string[] {
  const at = path || "(value)";
  switch (node.type) {
    case "string":
      if (typeof value !== "string") return [`${at}: must be a string.`];
      if (node.enum && !node.enum.includes(value))
        return [`${at}: must be one of ${node.enum.join(", ")}.`];
      return [];
    case "number":
    case "integer":
      return typeof value === "number" ? [] : [`${at}: must be a number.`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at}: must be a boolean.`];
    case "array":
      return Array.isArray(value)
        ? value.flatMap((v, i) => check(node.items, v, `${path}/${i}`))
        : [`${at}: must be an array.`];
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [`${at}: must be an object.`];
      const o = value as Record<string, unknown>;
      return [
        ...(node.required ?? [])
          .filter((r) => o[r] === undefined)
          .map((r) => `${at}: missing required property '${r}'.`),
        ...Object.entries(node.properties).flatMap(([k, child]) =>
          o[k] === undefined ? [] : check(child, o[k], `${path}/${k}`),
        ),
      ];
    }
  }
}

const checker: SchemaChecker = {
  checkSchema: checkSchemaFeatures,
  checkData: (body, value) => check(body as SchemaNode, value),
};

const TASK = {
  type: "object",
  properties: { task: { type: "string" }, isDone: { type: "boolean" } },
  required: ["task"],
};
const TASK_V2 = {
  type: "object",
  properties: {
    task: { type: "string" },
    isDone: { type: "boolean" },
    priority: {
      type: "string",
      enum: ["low", "medium", "high"],
      default: "medium",
    },
  },
  required: ["task", "priority"],
};

let n = 0;
const access = (
  session: SessionData,
  ops: DataOp[],
  agent: DataAgent | null = null,
) =>
  createDataAccess({
    session,
    sessionOps: ops,
    checker,
    projectId: null,
    agent,
    author: { by: "model", sessionId: "s", runId: "r" },
    newId: () => `id${++n}`,
  });

const toolMessage = (dataOps: DataOp[]): Message => ({
  role: "tool",
  callId: "c",
  name: "t",
  content: "",
  isError: false,
  dataOps,
});

describe("applyMergePatch (RFC 7396)", () => {
  it("merges objects, removes null fields and replaces arrays", () => {
    expect(
      applyMergePatch(
        { a: 1, b: { c: 2, d: 3 }, list: [1, 2], gone: true },
        { b: { d: 4 }, list: [9], gone: null, added: "x" },
      ),
    ).toEqual({ a: 1, b: { c: 2, d: 4 }, list: [9], added: "x" });
  });

  it("replaces the value when the patch is not an object", () => {
    expect(applyMergePatch({ a: 1 }, true)).toBe(true);
    expect(applyMergePatch(false, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("applyDefaults", () => {
  it("fills missing properties, inside nested objects too", () => {
    const node: SchemaNode = {
      type: "object",
      properties: {
        priority: { type: "string", default: "medium" },
        set: { type: "string", default: "x" },
        meta: {
          type: "object",
          properties: { n: { type: "integer", default: 0 } },
        },
      },
    };
    expect(applyDefaults(node, { set: "kept", meta: {} })).toEqual({
      priority: "medium",
      set: "kept",
      meta: { n: 0 },
    });
  });

  it("leaves a value without defaults alone", () => {
    expect(applyDefaults({ type: "boolean" }, true)).toBe(true);
  });
});

describe("session schemas and data", () => {
  it("creates, records and replays a schema and its data", () => {
    const ops: DataOp[] = [];
    const data = access(replaySessionData([]), ops);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "A task to complete.",
      body: TASK,
    });
    const created = data.createData({
      scope: "session",
      schemaId: schema.id,
      name: "Draft scene 2",
      description: "The second scene.",
      value: { task: "Draft scene 2", isDone: false },
    });
    expect(created).toMatchObject({ schemaVersion: 1, outOfDate: false });
    expect(ops.map((o) => o.op)).toEqual(["schema_put", "data_put"]);

    const replayed = access(replaySessionData([toolMessage(ops)]), []);
    expect(replayed.listSchemas()).toHaveLength(1);
    expect(replayed.getData(created.id).value).toEqual({
      task: "Draft scene 2",
      isDone: false,
    });
  });

  it("refuses an invalid schema, value or name", () => {
    const data = access(replaySessionData([]), []);
    expect(() =>
      data.createSchema({
        scope: "session",
        name: "Bad",
        description: "d",
        body: { type: "object", propertys: {} },
      }),
    ).toThrow(/unsupported keyword "propertys"/);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    expect(() =>
      data.createSchema({
        scope: "session",
        name: "Task",
        description: "d",
        body: TASK,
      }),
    ).toThrow(/already exists/);
    expect(() =>
      data.createData({
        scope: "session",
        schemaId: schema.id,
        name: "x",
        description: "d",
        value: { isDone: 1 },
      }),
    ).toThrow(DataError);
    expect(() =>
      data.createData({
        scope: "session",
        schemaId: schema.id,
        name: " ",
        description: "d",
        value: { task: "t" },
      }),
    ).toThrow(/name is required/);
  });

  it("has no scope beyond the session without shared storage", () => {
    const data = access(replaySessionData([]), []);
    expect(data.scopes).toEqual(["session"]);
    expect(() =>
      data.createSchema({
        scope: "global",
        name: "T",
        description: "d",
        body: TASK,
      }),
    ).toThrow(/global scope is not available/);
  });

  it("updates with a merge patch against the pinned version", () => {
    const data = access(replaySessionData([]), []);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    const d = data.createData({
      scope: "session",
      schemaId: schema.id,
      name: "t",
      description: "d",
      value: { task: "a", isDone: false },
    });
    expect(data.updateData(d.id, { patch: { isDone: true } }).value).toEqual({
      task: "a",
      isDone: true,
    });
    expect(() => data.updateData(d.id, { patch: { task: null } })).toThrow(
      /missing required property 'task'/,
    );
  });

  it("versions only a changed JSON Schema; renames stay in place", () => {
    const data = access(replaySessionData([]), []);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    expect(data.updateSchema(schema.id, { name: "Chore" }).version).toBe(1);
    expect(data.updateSchema(schema.id, { body: TASK }).version).toBe(1);
    expect(data.updateSchema(schema.id, { body: TASK_V2 }).version).toBe(2);
    expect(data.schemaBody(schema.id, 1)).toEqual(TASK);
  });

  it("bumps passing data on read and flags failing data with errors", () => {
    const data = access(replaySessionData([]), []);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    const passes = data.createData({
      scope: "session",
      schemaId: schema.id,
      name: "has priority",
      description: "d",
      value: { task: "a", priority: "low" },
    });
    const fails = data.createData({
      scope: "session",
      schemaId: schema.id,
      name: "no priority",
      description: "d",
      value: { task: "b" },
    });
    data.updateSchema(schema.id, { body: TASK_V2 });
    expect(data.getData(passes.id)).toMatchObject({
      schemaVersion: 2,
      outOfDate: false,
    });
    const view = data.getData(fails.id);
    expect(view).toMatchObject({ schemaVersion: 1, outOfDate: true });
    expect(view.latestErrors.join()).toMatch(/priority/);

    // An edit keeps the pinned version (decision 26).
    expect(
      data.updateData(fails.id, { patch: { isDone: true } }),
    ).toMatchObject({ schemaVersion: 1, outOfDate: true });
    // A migration fills the default and moves it (decision 27).
    const migrated = data.migrateData(fails.id, undefined, undefined);
    expect(migrated).toMatchObject({ schemaVersion: 2, outOfDate: false });
    expect(migrated.value).toMatchObject({ priority: "medium" });
    expect(() => data.migrateData(fails.id, 2, undefined)).toThrow(
      /migrate it to a newer one/,
    );
  });

  it("hides data with its deleted schema", () => {
    const data = access(replaySessionData([]), []);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    data.createData({
      scope: "session",
      schemaId: schema.id,
      name: "t",
      description: "d",
      value: { task: "a" },
    });
    expect(data.deleteSchema(schema.id)).toEqual({ data: 1 });
    expect(data.listSchemas()).toEqual([]);
    expect(data.listData()).toEqual([]);
  });

  it("copies a schema as a new one at version 1", () => {
    const data = access(replaySessionData([]), []);
    const schema = data.createSchema({
      scope: "session",
      name: "Task",
      description: "d",
      body: TASK,
    });
    data.updateSchema(schema.id, { body: TASK_V2 });
    const copy = data.copySchema(schema.id, "session", "Task copy");
    expect(copy).toMatchObject({ version: 1, copiedFrom: schema.id });
    expect(data.schemaBody(copy.id)).toEqual(TASK_V2);
  });
});
