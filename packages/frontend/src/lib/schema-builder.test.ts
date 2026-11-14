import { describe, expect, it } from "vitest";
import { checkSchemaFeatures } from "@harness/core";
import {
  addField,
  changeType,
  checkTree,
  flatten,
  fromSchema,
  moveField,
  newNode,
  removeField,
  toSchema,
  updateNode,
  type BuilderNode,
} from "./schema-builder";

const TASK = {
  type: "object",
  title: "Task",
  properties: {
    title: { type: "string", minLength: 1 },
    status: {
      type: "string",
      enum: ["todo", "in_progress", "done", "blocked", "paused"],
      default: "todo",
    },
    when: { type: "string", format: "date" },
    tier: { type: "integer", enum: [1, 2], default: 1 },
    hp: { type: "integer", minimum: 0, maximum: 10 },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    steps: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: { text: { type: "string" }, done: { type: "boolean" } },
        required: ["text"],
      },
    },
  },
  required: ["title", "status"],
};

const tree = (body: unknown): BuilderNode => {
  const r = fromSchema(body);

  if (!r.ok) throw new Error(r.reason);

  return r.root;
};

describe("fromSchema and toSchema", () => {
  it("round-trips every supported feature", () => {
    expect(toSchema(tree(TASK))).toEqual({
      ...TASK,
      properties: {
        ...TASK.properties,
        tier: { type: "number", enum: [1, 2], default: 1 },
      },
    });
  });

  it("makes schemas that pass the features check", () => {
    expect(checkSchemaFeatures(toSchema(tree(TASK)))).toEqual([]);
  });

  it("reads fields, groups and lists into a tree", () => {
    expect(
      flatten(tree(TASK)).map((f) => [
        f.node.key || f.role,
        f.node.type,
        f.depth,
      ]),
    ).toEqual([
      ["title", "text", 0],
      ["status", "choice", 0],
      ["when", "text", 0],
      ["tier", "choice", 0],
      ["hp", "integer", 0],
      ["tags", "multi", 0],
      ["steps", "list", 0],
      ["item", "group", 1],
      ["text", "text", 2],
      ["done", "boolean", 2],
    ]);
  });

  it("refuses what the builder can't show", () => {
    expect(fromSchema({ type: "object", propertys: {} })).toMatchObject({
      ok: false,
    });
    expect(
      fromSchema({
        type: "object",
        properties: {},
        default: { a: 1 },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/as JSON/) });
  });

  it("handles a top-level scalar", () => {
    expect(toSchema(tree({ type: "boolean", title: "Done?" }))).toEqual({
      type: "boolean",
      title: "Done?",
    });
  });
});

describe("editing the tree", () => {
  it("adds, renames, moves and removes fields", () => {
    let root = newNode("group");
    const a = { ...newNode("text", "a"), required: true };
    const b = newNode("boolean", "b");

    root = addField(addField(root, root.id, a), root.id, b);
    root = moveField(root, b.id, -1);
    root = updateNode(root, a.id, (n) => ({ ...n, key: "name" }));
    expect(toSchema(root)).toEqual({
      type: "object",
      properties: { b: { type: "boolean" }, name: { type: "string" } },
      required: ["name"],
    });
    root = removeField(root, b.id);
    expect(
      Object.keys((toSchema(root) as { properties: object }).properties),
    ).toEqual(["name"]);
  });

  it("changes a field's type, keeping its name and label", () => {
    const n = { ...newNode("text", "mood"), title: "Mood", minLength: 3 };

    expect(changeType(n, "choice")).toMatchObject({
      id: n.id,
      key: "mood",
      title: "Mood",
      type: "choice",
      options: [],
    });
    expect(changeType(n, "choice").minLength).toBeUndefined();
  });
});

describe("checkTree", () => {
  it("finds missing and repeated names, empty options and bad patterns", () => {
    let root = newNode("group");
    const blank = newNode("text");
    const one = newNode("text", "x");
    const two = newNode("number", "x");
    const choice = newNode("choice", "c");
    const pattern = { ...newNode("text", "p"), pattern: "(" };

    for (const n of [blank, one, two, choice, pattern]) {
      root = addField(root, root.id, n);
    }

    expect(checkTree(root)).toEqual({
      [blank.id]: "Give the field a name.",
      [two.id]: 'Another field here is named "x".',
      [choice.id]: "Add at least one option.",
      [pattern.id]: "The pattern is not a valid regular expression.",
    });
  });
});
