import type { SchemaInfo, SchemaScope } from "@harness/core";
import type { DataItem, DataOwner } from "../api";
import {
  loadViewIn,
  nodeValue,
  openTabIn,
  parseNodeValueOf,
  saveViewIn,
  type ExplorerTab,
  type PageKey,
  type Root,
  type RootId,
  type SavedViewOf,
  type TabsOf,
  type TreeNode,
} from "./explorer";

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
  path: string;
}

export function parseNodeValue(value: string): NodeRef {
  const r = parseNodeValueOf(value);

  return { root: r.root, kind: r.kind as NodeKind, path: r.path };
}

export interface NodeInfo {
  name: string;
  deleted: boolean;
  schemaScope?: SchemaScope;
  inherited?: boolean;
  outOfDate?: boolean;
}

export interface StructuredRoot extends Root<DataOwner> {
  readOnly?: string | undefined;
}

export interface RootData {
  root: Root<DataOwner>;
  schemas: readonly SchemaInfo[];
  data: readonly DataItem[];
}

export type Pending =
  | { kind: "new-schema"; root: RootId }
  | { kind: "new-data"; root: RootId; schemaId: string };

const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

export const isInherited = (
  schema: SchemaInfo,
  root: Root<DataOwner>,
): boolean =>
  schema.scope === "builtin"
    ? root.scope.scope !== "global"
    : schema.scope !== root.scope.scope;

export const scopeName = (scope: SchemaScope): string =>
  scope === "builtin"
    ? "Built-in"
    : scope.charAt(0).toUpperCase() + scope.slice(1);

export function schemaTabRoot(
  scope: SchemaScope,
  from: RootId,
  roots: readonly Root<DataOwner>[],
): RootId {
  const home = scope === "builtin" ? "global" : scope;

  return roots.find((r) => r.scope.scope === home)?.id ?? from;
}

export function mergeSchemas(
  own: readonly SchemaInfo[],
  usable: readonly SchemaInfo[],
): SchemaInfo[] {
  const byId = new Map<string, SchemaInfo>();

  for (const s of usable) byId.set(s.id, s);

  for (const s of own) byId.set(s.id, s);

  return [...byId.values()];
}

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

export type TabState = ExplorerTab<"schema" | "data">;
export type TabsState = TabsOf<TabState>;

export const openTab = (
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState => openTabIn(state, tab, permanent, () => true);

export const tabNode = (t: TabState): string =>
  nodeValue({ root: t.root, kind: t.kind, path: t.key });

export type SavedView = SavedViewOf<TabState>;

const KINDS = ["schema", "data"] as const;

export const loadView = (
  page: PageKey,
  isRoot?: (v: unknown) => boolean,
): SavedView => loadViewIn("structured", page, KINDS, isRoot);

export const saveView = (page: PageKey, view: SavedView): void =>
  saveViewIn("structured", page, view);
