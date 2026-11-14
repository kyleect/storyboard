import {
  checkSchemaFeatures,
  SCHEMA_FORMATS,
  type SchemaNode,
} from "@harness/core";

export type FieldType =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "choice"
  | "multi"
  | "group"
  | "list";

export type TextFormat = "" | (typeof SCHEMA_FORMATS)[number];

export interface BuilderNode {
  id: string;
  key: string;
  type: FieldType;
  title: string;
  description: string;
  required: boolean;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern: string;
  format: TextFormat;
  minimum?: number | undefined;
  maximum?: number | undefined;
  options: string[];
  numeric: boolean;
  default?: unknown;
  children: BuilderNode[];
  item?: BuilderNode | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
}

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Whole number" },
  { value: "boolean", label: "Yes / no" },
  { value: "choice", label: "Choice" },
  { value: "multi", label: "Several choices" },
  { value: "group", label: "Group of fields" },
  { value: "list", label: "List" },
];

let counter = 0;
const newId = () => `f${++counter}`;

export function newNode(type: FieldType, key = ""): BuilderNode {
  return {
    id: newId(),
    key,
    type,
    title: "",
    description: "",
    required: false,
    pattern: "",
    format: "",
    options: [],
    numeric: false,
    children: [],
    ...(type === "list" ? { item: newNode("text") } : {}),
  };
}

export function changeType(node: BuilderNode, type: FieldType): BuilderNode {
  return {
    ...newNode(type, node.key),
    id: node.id,
    title: node.title,
    description: node.description,
    required: node.required,
  };
}

export function fromSchema(
  body: unknown,
): { ok: true; root: BuilderNode } | { ok: false; reason: string } {
  const problems = checkSchemaFeatures(body);

  if (problems.length > 0) {
    return { ok: false, reason: problems.join("\n") };
  }

  try {
    return { ok: true, root: toNode(body as SchemaNode, "", false) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function toNode(n: SchemaNode, key: string, required: boolean): BuilderNode {
  const base = {
    ...newNode("text", key),
    title: n.title ?? "",
    description: n.description ?? "",
    required,
  };

  switch (n.type) {
    case "string":
      if (n.enum) {
        return {
          ...base,
          type: "choice",
          options: n.enum,
          ...(n.default !== undefined ? { default: n.default } : {}),
        };
      }

      return {
        ...base,
        type: "text",
        minLength: n.minLength,
        maxLength: n.maxLength,
        pattern: n.pattern ?? "",
        format: n.format ?? "",
        ...(n.default !== undefined ? { default: n.default } : {}),
      };
    case "number":
    case "integer":
      if (n.enum) {
        return {
          ...base,
          type: "choice",
          numeric: true,
          options: n.enum.map(String),
          ...(n.default !== undefined ? { default: String(n.default) } : {}),
        };
      }

      return {
        ...base,
        type: n.type,
        minimum: n.minimum,
        maximum: n.maximum,
        ...(n.default !== undefined ? { default: n.default } : {}),
      };
    case "boolean":
      return {
        ...base,
        type: "boolean",
        ...(n.default !== undefined ? { default: n.default } : {}),
      };
    case "array":
      if (
        n.default !== undefined &&
        !(n.items.type === "string" && n.items.enum)
      ) {
        throw new Error(
          `${key || "The list"} has a default, which the builder can't show. Edit it as JSON.`,
        );
      }

      if (n.items.type === "string" && n.items.enum) {
        return {
          ...base,
          type: "multi",
          options: n.items.enum,
          minItems: n.minItems,
          maxItems: n.maxItems,
          ...(n.default !== undefined ? { default: n.default } : {}),
        };
      }

      return {
        ...base,
        type: "list",
        item: toNode(n.items, "", false),
        minItems: n.minItems,
        maxItems: n.maxItems,
      };
    case "object": {
      if (n.default !== undefined) {
        throw new Error(
          `${key || "The schema"} has a default for a group, which the builder can't show. Edit it as JSON.`,
        );
      }

      const required = new Set(n.required ?? []);

      return {
        ...base,
        type: "group",
        children: Object.entries(n.properties).map(([k, child]) =>
          toNode(child, k, required.has(k)),
        ),
      };
    }
  }
}

const clean = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== ""),
  );
const defined = (o: Record<string, unknown>): SchemaNode =>
  clean(o) as unknown as SchemaNode;

export function toSchema(node: BuilderNode): SchemaNode {
  const head = clean({ title: node.title, description: node.description });

  switch (node.type) {
    case "text":
      return defined({
        type: "string" as const,
        ...head,
        minLength: node.minLength,
        maxLength: node.maxLength,
        pattern: node.pattern,
        format: node.format === "" ? undefined : node.format,
        default:
          typeof node.default === "string" && node.default !== ""
            ? node.default
            : undefined,
      });
    case "number":
    case "integer":
      return defined({
        type: node.type,
        ...head,
        minimum: node.minimum,
        maximum: node.maximum,
        default: typeof node.default === "number" ? node.default : undefined,
      });
    case "boolean":
      return defined({
        type: "boolean" as const,
        ...head,
        default: typeof node.default === "boolean" ? node.default : undefined,
      });
    case "choice": {
      const picked =
        typeof node.default === "string" && node.options.includes(node.default)
          ? node.default
          : undefined;

      if (node.numeric) {
        return defined({
          type: "number" as const,
          ...head,
          enum: node.options.map(Number),
          default: picked !== undefined ? Number(picked) : undefined,
        });
      }

      return defined({
        type: "string" as const,
        ...head,
        enum: node.options,
        default: picked,
      });
    }
    case "multi":
      return defined({
        type: "array" as const,
        ...head,
        items: { type: "string" as const, enum: node.options },
        minItems: node.minItems,
        maxItems: node.maxItems,
        default:
          Array.isArray(node.default) && node.default.length > 0
            ? node.default.filter((d) => node.options.includes(String(d)))
            : undefined,
      });
    case "list":
      return defined({
        type: "array" as const,
        ...head,
        items: toSchema(node.item ?? newNode("text")),
        minItems: node.minItems,
        maxItems: node.maxItems,
      });
    case "group": {
      const required = node.children
        .filter((c) => c.required)
        .map((c) => c.key);

      return defined({
        type: "object" as const,
        ...head,
        properties: Object.fromEntries(
          node.children.map((c) => [c.key, toSchema(c)]),
        ),
        required: required.length > 0 ? required : undefined,
      });
    }
  }
}

export function checkTree(root: BuilderNode): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (node: BuilderNode, inGroup: boolean) => {
    if (inGroup && node.key.trim() === "")
      out[node.id] = "Give the field a name.";

    if (
      (node.type === "choice" || node.type === "multi") &&
      node.options.length === 0
    ) {
      out[node.id] ??= "Add at least one option.";
    }

    if (
      node.type === "choice" &&
      node.numeric &&
      node.options.some((o) => !Number.isFinite(Number(o)))
    ) {
      out[node.id] ??= "Every option must be a number.";
    }

    if (node.type === "text" && node.pattern !== "") {
      try {
        new RegExp(node.pattern);
      } catch {
        out[node.id] ??= "The pattern is not a valid regular expression.";
      }
    }

    if (node.type === "group") {
      const seen = new Set<string>();

      for (const c of node.children) {
        if (c.key.trim() !== "" && seen.has(c.key)) {
          out[c.id] ??= `Another field here is named "${c.key}".`;
        }

        seen.add(c.key);
        visit(c, true);
      }
    }

    if (node.type === "list" && node.item) visit(node.item, false);
  };

  visit(root, false);

  return out;
}

export function flatten(root: BuilderNode): {
  node: BuilderNode;
  depth: number;
  parent: BuilderNode | null;
  role: "field" | "item";
}[] {
  const out: ReturnType<typeof flatten> = [];
  const walk = (node: BuilderNode, depth: number) => {
    if (node.type === "group") {
      for (const c of node.children) {
        out.push({ node: c, depth, parent: node, role: "field" });
        walk(c, depth + 1);
      }
    }

    if (node.type === "list" && node.item) {
      out.push({ node: node.item, depth, parent: node, role: "item" });
      walk(node.item, depth + 1);
    }
  };

  walk(root, 0);

  return out;
}

export function updateNode(
  root: BuilderNode,
  id: string,
  change: (n: BuilderNode) => BuilderNode,
): BuilderNode {
  if (root.id === id) return change(root);

  return {
    ...root,
    children: root.children.map((c) => updateNode(c, id, change)),
    ...(root.item ? { item: updateNode(root.item, id, change) } : {}),
  };
}

export function addField(
  root: BuilderNode,
  groupId: string,
  node: BuilderNode,
): BuilderNode {
  return updateNode(root, groupId, (g) => ({
    ...g,
    children: [...g.children, node],
  }));
}

export function removeField(root: BuilderNode, id: string): BuilderNode {
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => removeField(c, id)),
    ...(root.item ? { item: removeField(root.item, id) } : {}),
  };
}

export function moveField(
  root: BuilderNode,
  id: string,
  by: -1 | 1,
): BuilderNode {
  const at = root.children.findIndex((c) => c.id === id);

  if (at >= 0) {
    const to = at + by;

    if (to < 0 || to >= root.children.length) return root;

    const children = [...root.children];

    [children[at], children[to]] = [
      children[to] as BuilderNode,
      children[at] as BuilderNode,
    ];

    return { ...root, children };
  }

  return {
    ...root,
    children: root.children.map((c) => moveField(c, id, by)),
    ...(root.item ? { item: moveField(root.item, id, by) } : {}),
  };
}

export function findNode(
  root: BuilderNode,
  id: string,
): BuilderNode | undefined {
  if (root.id === id) return root;

  for (const c of root.children) {
    const found = findNode(c, id);

    if (found) return found;
  }

  return root.item ? findNode(root.item, id) : undefined;
}
