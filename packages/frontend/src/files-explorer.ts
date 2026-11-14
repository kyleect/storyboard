import {
  isInFolder,
  joinPath,
  parentFolders,
  type MediaType,
} from "@harness/core";
import type { StoredFile, FileScope } from "./api";
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

/*
 * The logic behind the editor-style Files view (`routes/FilesExplorer.tsx`):
 * which roots a page shows, the tree built from their files and folders, the
 * rules for opening and closing tabs, and what is remembered between visits.
 * Pure, so it is tested without a DOM.
 */

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

/** The roots the Files view shows: the files available at the page's scope. */
export const rootsFor = (
  page: FileScope,
  projectId: string | null | undefined,
): Root[] => sharedRootsFor(page, projectId);

/** How a new file's type follows its extension. */
export function mediaTypeForName(name: string): MediaType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return "text/plain";
}

/** What a new, empty file holds: JSON must parse, so it starts as `{}`. */
export const emptyValueFor = (mediaType: MediaType): string =>
  mediaType === "application/json" ? "{}" : "";

/** The last name of a path. */
export const baseName = (path: string): string => path.split("/").at(-1) ?? "";

/** The folder a path is in; empty at the top level. */
export const dirName = (path: string): string =>
  path.split("/").slice(0, -1).join("/");

// ---------------------------------------------------------------- the tree

export type NodeKind = "root" | "folder" | "file" | "new-file" | "new-folder";

export interface NodeRef {
  root: RootId;
  kind: NodeKind;
  /** Empty for a root. */
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
  mediaType?: MediaType | undefined;
}

export interface RootData {
  root: Pick<Root, "id" | "label">;
  files: readonly StoredFile[];
  folders: readonly string[];
}

/** An inline name box in the tree: a file or folder being created. */
export interface Pending {
  kind: "new-file" | "new-folder";
  root: RootId;
  /** The folder it goes in; empty for the root. */
  parent: string;
}

const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

/**
 * One tree for every root: each root holds its folders (folders first) and
 * files, by name. A folder is shown when it was made or holds a file. A
 * pending name box comes first inside its folder.
 */
export function buildTree(
  inputs: readonly RootData[],
  pending: Pending | null,
): { data: TreeNode[]; info: Map<string, NodeInfo> } {
  const info = new Map<string, NodeInfo>();
  const data = inputs.map(({ root, files, folders }) => {
    // Every folder, with the ones above it, so none hangs without a parent.
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

// ----------------------------------------------------------------- the tabs

/** A tab: a file, or the rendered view of a Markdown file (its own tab). */
export type TabState = ExplorerTab<"file" | "preview">;

export type TabsState = TabsOf<TabState>;

/**
 * Opens a file or preview tab (see `openTabIn`). A preview tab is permanent
 * from the start.
 */
export const openTab = (
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState => openTabIn(state, tab, permanent, (k) => k === "file");

/** Follows a folder rename in the keys of the open tabs. */
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

// -------------------------------------------------- remembered between visits

export type SavedView = SavedViewOf<TabState>;

/** The kinds of tab a file explorer has. */
export const FILE_TAB_KINDS = ["file", "preview"] as const;

/** Reads what was saved for a page; anything unreadable is dropped. */
export const loadView = (page: FileScope): SavedView =>
  loadViewIn("files", page, FILE_TAB_KINDS);

export const saveView = (page: FileScope, view: SavedView): void =>
  saveViewIn("files", page, view);
