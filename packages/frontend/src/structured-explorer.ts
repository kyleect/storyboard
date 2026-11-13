import type { SchemaInfo, SchemaScope } from "@harness/core";
import type { DataItem, FileScope } from "./api";
import {
  loadViewIn,
  nodeValue,
  openTabIn,
  parseNodeValueOf,
  saveViewIn,
  type ExplorerTab,
  type Root,
  type RootId,
  type SavedViewOf,
  type TabsOf,
  type TreeNode,
} from "./explorer";

/*
 * The logic behind the editor-style Structured Data view
 * (`routes/StructuredExplorer.tsx`): the tree of Session, Project and Global
 * roots, each with a Schemas folder, a row for every schema it can make data
 * from, and the data under each schema. The roots, the tab rules and what is
 * remembered are shared with the Files view (`explorer.ts`). Pure, so it is
 * tested without a DOM.
 */

export type NodeKind =
  | "root"
  | "schemas"
  | "schema"
  | "unknown"
  | "data"
  | "new-schema"
  | "new-data";

export interface NodeRef {
  root: RootId;
  kind: NodeKind;
  /** A schema's or a piece of data's id; empty for a root or Schemas folder. */
  path: string;
}

export function parseNodeValue(value: string): NodeRef {
  const r = parseNodeValueOf(value);
  return { root: r.root, kind: r.kind as NodeKind, path: r.path };
}

/** What a row needs besides its place in the tree. */
export interface NodeInfo {
  name: string;
  deleted: boolean;
  /** Schema rows: where the schema lives. */
  schemaScope?: SchemaScope;
  /** A schema from a higher scope than the root it is shown under. */
  inherited?: boolean;
  /** Data rows: pinned to an older version of the schema. */
  outOfDate?: boolean;
}

export interface RootData {
  root: Root;
  /** The schemas this root can make data from, with its own. */
  schemas: readonly SchemaInfo[];
  /** The data this root's scope holds. */
  data: readonly DataItem[];
}

/** An inline name box in the tree: a schema or a piece of data being made. */
export type Pending =
  | { kind: "new-schema"; root: RootId }
  | { kind: "new-data"; root: RootId; schemaId: string };

const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

/**
 * A schema from a higher scope than the root it is shown under. The built-in
 * schemas are the Global root's own (the Global page lists them), and
 * inherited anywhere below it.
 */
export const isInherited = (schema: SchemaInfo, root: Root): boolean =>
  schema.scope === "builtin"
    ? root.id !== "global"
    : schema.scope !== root.scope.scope;

/** Name of a scope for a person: "Global", "Project", "Session", "Agent". */
export const scopeName = (scope: SchemaScope): string =>
  scope === "builtin"
    ? "Built-in"
    : scope.charAt(0).toUpperCase() + scope.slice(1);

/**
 * The root a schema's tab belongs to: the root of the scope it lives in, so
 * one schema is one tab, however many roots show it. Built-in schemas are
 * global. An agent's schema has no root of its own; it belongs to the root
 * it was opened from.
 */
export function schemaTabRoot(scope: SchemaScope, from: RootId): RootId {
  if (scope === "builtin") return "global";
  if (scope === "agent") return from;
  return scope;
}

/**
 * Merges a root's own schemas (listed with the deleted ones when asked) into
 * the schemas it can make data from; one entry per schema.
 */
export function mergeSchemas(
  own: readonly SchemaInfo[],
  usable: readonly SchemaInfo[],
): SchemaInfo[] {
  const byId = new Map<string, SchemaInfo>();
  for (const s of usable) byId.set(s.id, s);
  for (const s of own) byId.set(s.id, s);
  return [...byId.values()];
}

/**
 * One tree for every root: each root holds a Schemas folder; the folder holds
 * a row per schema, by name; each schema holds its data, by name. Data whose
 * schema is not among the root's schemas goes under an "Unknown schema" row.
 * A pending name box comes first in its folder.
 */
export function buildTree(
  inputs: readonly RootData[],
  pending: Pending | null,
): { data: TreeNode[]; info: Map<string, NodeInfo> } {
  const info = new Map<string, NodeInfo>();
  const data = inputs.map(({ root, schemas, data: items }) => {
    const top: TreeNode = {
      label: root.label,
      value: nodeValue({ root: root.id, kind: "root", path: "" }),
      children: [],
    };
    info.set(top.value, { name: root.label, deleted: false });
    const folder: TreeNode = {
      label: "Schemas",
      value: nodeValue({ root: root.id, kind: "schemas", path: "" }),
      children: [],
    };
    info.set(folder.value, { name: "Schemas", deleted: false });
    top.children?.push(folder);

    const dataRow = (d: DataItem): TreeNode => {
      const node: TreeNode = {
        label: d.name,
        value: nodeValue({ root: root.id, kind: "data", path: d.id }),
      };
      info.set(node.value, {
        name: d.name,
        deleted: d.deleted,
        outOfDate: d.outOfDate,
      });
      return node;
    };

    const known = new Set(schemas.map((s) => s.id));
    const nodes = new Map<string, TreeNode>();
    for (const s of schemas) {
      const node: TreeNode = {
        label: s.name,
        value: nodeValue({ root: root.id, kind: "schema", path: s.id }),
        children: [],
      };
      nodes.set(s.id, node);
      info.set(node.value, {
        name: s.name,
        deleted: s.deleted,
        schemaScope: s.scope,
        inherited: isInherited(s, root),
      });
      folder.children?.push(node);
    }
    const orphans: DataItem[] = [];
    for (const d of items) {
      const parent = nodes.get(d.schemaId);
      if (parent && known.has(d.schemaId)) parent.children?.push(dataRow(d));
      else orphans.push(d);
    }
    if (orphans.length > 0) {
      const node: TreeNode = {
        label: "Unknown schema",
        value: nodeValue({ root: root.id, kind: "unknown", path: "" }),
        children: orphans.map(dataRow),
      };
      info.set(node.value, { name: "Unknown schema", deleted: false });
      folder.children?.push(node);
    }
    const sortRows = (n: TreeNode) => {
      n.children?.sort(byName);
    };
    sortRows(folder);
    // "Unknown schema" is last, whatever its name sorts as.
    const unknown = folder.children?.findIndex(
      (c) => parseNodeValue(c.value).kind === "unknown",
    );
    if (unknown !== undefined && unknown >= 0 && folder.children) {
      const [moved] = folder.children.splice(unknown, 1);
      if (moved) folder.children.push(moved);
    }
    for (const n of folder.children ?? []) sortRows(n);

    if (pending && pending.root === root.id) {
      if (pending.kind === "new-schema") {
        folder.children?.unshift({
          label: "",
          value: nodeValue({ root: root.id, kind: "new-schema", path: "" }),
        });
      } else {
        const parent = nodes.get(pending.schemaId);
        parent?.children?.unshift({
          label: "",
          value: nodeValue({
            root: root.id,
            kind: "new-data",
            path: pending.schemaId,
          }),
        });
      }
    }
    return top;
  });
  return { data, info };
}

// ----------------------------------------------------------------- the tabs

/** A tab: a schema, or a piece of data. */
export type TabState = ExplorerTab<"schema" | "data">;
export type TabsState = TabsOf<TabState>;

/** Opens a schema or data tab (see `openTabIn`). */
export const openTab = (
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState => openTabIn(state, tab, permanent, () => true);

/** The tree node a tab stands for. */
export const tabNode = (t: TabState): string =>
  nodeValue({ root: t.root, kind: t.kind, path: t.key });

// -------------------------------------------------- remembered between visits

export type SavedView = SavedViewOf<TabState>;

const KINDS = ["schema", "data"] as const;

export const loadView = (page: FileScope): SavedView =>
  loadViewIn("structured", page, KINDS);

export const saveView = (page: FileScope, view: SavedView): void =>
  saveViewIn("structured", page, view);
