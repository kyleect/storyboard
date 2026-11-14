import {
  isInFolder,
  joinPath,
  parentFolders,
  type MediaType,
} from "@harness/core";
import type { StoredFile, FileScope } from "../api";
import {
  loadViewIn,
  nodeValue,
  openTabIn,
  parseNodeValueOf,
  rootsFor as sharedRootsFor,
  saveViewIn,
  tabId,
  type ExplorerTab,
  type Root,
  type RootId,
  type SavedViewOf,
  type TabsOf,
  type TreeNode,
} from "./explorer";

export {
  clampWidth,
  closeTab,
  DEFAULT_WIDTH,
  isHigherScope,
  keepTab,
  MAX_WIDTH,
  MIN_WIDTH,
  nodeValue,
  rootLabel,
  tabId,
  type Root,
  type RootId,
  type TreeNode,
} from "./explorer";

export const rootsFor = (
  page: FileScope,
  projectId: string | null | undefined,
): Root[] => sharedRootsFor(page, projectId);

export function mediaTypeForName(name: string): MediaType {
  const lower = name.toLowerCase();

  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return "text/markdown";

  if (lower.endsWith(".json")) return "application/json";

  return "text/plain";
}

export const emptyValueFor = (mediaType: MediaType): string =>
  mediaType === "application/json" ? "{}" : "";

export const baseName = (path: string): string => path.split("/").at(-1) ?? "";

export const dirName = (path: string): string =>
  path.split("/").slice(0, -1).join("/");

export type NodeKind = "root" | "folder" | "file" | "new-file" | "new-folder";

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
  mediaType?: MediaType | undefined;
}

export interface RootData {
  root: Pick<Root, "id" | "label">;
  files: readonly StoredFile[];
  folders: readonly string[];
}

export interface Pending {
  kind: "new-file" | "new-folder";
  root: RootId;
  parent: string;
}

const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

export function buildTree(
  inputs: readonly RootData[],
  pending: Pending | null,
): { data: TreeNode[]; info: Map<string, NodeInfo> } {
  const info = new Map<string, NodeInfo>();
  const data = inputs.map(({ root, files, folders }) => {
    const folderPaths = new Set<string>();

    for (const f of files) {
      for (const p of parentFolders(f.key)) folderPaths.add(p);
    }

    for (const path of folders) {
      for (const p of parentFolders(path)) folderPaths.add(p);

      folderPaths.add(path);
    }

    const nodes = new Map<string, TreeNode>();
    const top: TreeNode = {
      label: root.label,
      value: nodeValue({ root: root.id, kind: "root", path: "" }),
      children: [],
    };

    info.set(top.value, { name: root.label, deleted: false });
    const childrenOf = (folder: string): TreeNode[] =>
      folder === ""
        ? (top.children ?? [])
        : (nodes.get(folder)?.children ?? []);

    for (const path of [...folderPaths].sort()) {
      const node: TreeNode = {
        label: baseName(path),
        value: nodeValue({ root: root.id, kind: "folder", path }),
        children: [],
      };

      nodes.set(path, node);
      info.set(node.value, { name: node.label, deleted: false });
    }

    for (const path of folderPaths) {
      const node = nodes.get(path);

      if (node) childrenOf(dirName(path)).push(node);
    }

    for (const f of files) {
      const node: TreeNode = {
        label: baseName(f.key),
        value: nodeValue({ root: root.id, kind: "file", path: f.key }),
      };

      info.set(node.value, {
        name: node.label,
        deleted: f.deleted,
        mediaType: f.mediaType,
      });
      childrenOf(dirName(f.key)).push(node);
    }

    const sort = (n: TreeNode) => {
      n.children?.sort((a, b) => {
        const af = a.children ? 0 : 1;
        const bf = b.children ? 0 : 1;

        return af - bf || byName(a, b);
      });
      n.children?.forEach(sort);
    };

    sort(top);

    if (pending && pending.root === root.id) {
      const parent = pending.parent === "" ? top : nodes.get(pending.parent);
      const box: TreeNode = {
        label: "",
        value: nodeValue({
          root: root.id,
          kind: pending.kind,
          path: pending.parent,
        }),
      };

      (parent ?? top).children?.unshift(box);
    }

    return top;
  });

  return { data, info };
}

export type TabState = ExplorerTab<"file" | "preview">;

export type TabsState = TabsOf<TabState>;

export const openTab = (
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState => openTabIn(state, tab, permanent, (k) => k === "file");

export function renameFolderInTabs(
  state: TabsState,
  root: RootId,
  from: string,
  to: string,
): TabsState {
  const rename = (t: TabState): TabState =>
    t.root === root && isInFolder(t.key, from)
      ? { ...t, key: joinPath(to, t.key.slice(from.length + 1)) }
      : t;
  const tabs = state.tabs.map(rename);
  const active = state.tabs.find((t) => tabId(t) === state.active);

  return { tabs, active: active ? tabId(rename(active)) : null };
}

export type SavedView = SavedViewOf<TabState>;

export const FILE_TAB_KINDS = ["file", "preview"] as const;

export const loadView = (page: FileScope): SavedView =>
  loadViewIn("files", page, FILE_TAB_KINDS);

export const saveView = (page: FileScope, view: SavedView): void =>
  saveViewIn("files", page, view);
