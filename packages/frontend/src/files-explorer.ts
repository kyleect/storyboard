import {
  isInFolder,
  joinPath,
  parentFolders,
  type MediaType,
} from "@harness/core";
import type { Entry, EntryScope } from "./api";

/*
 * The logic behind the editor-style Files view (`routes/FilesExplorer.tsx`):
 * which roots a page shows, the tree built from their files and folders, the
 * rules for opening and closing tabs, and what is remembered between visits.
 * Pure, so it is tested without a DOM.
 */

/** The three places files live; each is a root folder in the tree. */
export type RootId = "session" | "project" | "global";

export interface Root {
  id: RootId;
  scope: EntryScope;
  label: string;
}

const LABEL: Record<RootId, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
};

/** Global is above project, which is above session. */
const RANK: Record<RootId, number> = { session: 1, project: 2, global: 3 };

export const rootLabel = (id: RootId): string => LABEL[id];

/**
 * The roots a page shows: the files available at its scope. A session sees
 * its own, its project's (when it has one) and the global ones; a project
 * sees its own and the global ones; the global page sees only the global
 * ones.
 */
export function rootsFor(
  page: EntryScope,
  projectId: string | null | undefined,
): Root[] {
  const roots: Root[] = [];
  if (page.scope === "session") {
    roots.push({ id: "session", scope: page, label: LABEL.session });
    if (projectId) {
      roots.push({
        id: "project",
        scope: { scope: "project", id: projectId },
        label: LABEL.project,
      });
    }
  } else if (page.scope === "project") {
    roots.push({ id: "project", scope: page, label: LABEL.project });
  }
  roots.push({
    id: "global",
    scope: { scope: "global" },
    label: LABEL.global,
  });
  return roots;
}

/** True when `target` is a higher scope than the page it is edited from. */
export const isHigherScope = (target: EntryScope, page: EntryScope): boolean =>
  RANK[target.scope] > RANK[page.scope];

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

/** A tree node's value: root, kind and path (the path may hold "|"). */
export const nodeValue = (r: NodeRef): string =>
  `${r.root}|${r.kind}|${r.path}`;

export function parseNodeValue(value: string): NodeRef {
  const first = value.indexOf("|");
  const second = value.indexOf("|", first + 1);
  return {
    root: value.slice(0, first) as RootId,
    kind: value.slice(first + 1, second) as NodeKind,
    path: value.slice(second + 1),
  };
}

export interface TreeNode {
  label: string;
  value: string;
  children?: TreeNode[];
}

/** What a row needs besides its place in the tree. */
export interface NodeInfo {
  name: string;
  deleted: boolean;
  mediaType?: MediaType | undefined;
}

export interface RootData {
  root: Root;
  files: readonly Entry[];
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
export interface TabState {
  kind: "file" | "preview";
  root: RootId;
  key: string;
  /** Shown in italics; the next single click on a file replaces it. */
  transient: boolean;
}

export const tabId = (t: Pick<TabState, "kind" | "root" | "key">): string =>
  `${t.kind}|${t.root}|${t.key}`;

export interface TabsState {
  tabs: TabState[];
  active: string | null;
}

/**
 * Opens a file or preview tab. A tab already open is activated, and kept
 * when `permanent`. A new file opened by a single click takes the place of
 * the open transient tab, if there is one.
 */
export function openTab(
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState {
  const id = tabId(tab);
  const existing = state.tabs.find((t) => tabId(t) === id);
  if (existing) {
    return {
      tabs: permanent
        ? state.tabs.map((t) =>
            tabId(t) === id ? { ...t, transient: false } : t,
          )
        : state.tabs,
      active: id,
    };
  }
  const added: TabState = {
    ...tab,
    transient: tab.kind === "file" && !permanent,
  };
  const at = added.transient ? state.tabs.findIndex((t) => t.transient) : -1;
  const tabs =
    at >= 0
      ? state.tabs.map((t, i) => (i === at ? added : t))
      : [...state.tabs, added];
  return { tabs, active: id };
}

/** Makes a tab permanent, as editing it does. */
export function keepTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => tabId(t) === id && t.transient)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      tabId(t) === id ? { ...t, transient: false } : t,
    ),
  };
}

/** Closes a tab; the next one to the right, else the left, becomes active. */
export function closeTab(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => tabId(t) === id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((_, i) => i !== at);
  if (state.active !== id) return { tabs, active: state.active };
  const next = tabs[at] ?? tabs[at - 1];
  return { tabs, active: next ? tabId(next) : null };
}

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

export interface SavedView {
  tabs: TabState[];
  active: string | null;
  expanded: Record<string, boolean>;
  width: number;
  showDeleted: boolean;
}

export const DEFAULT_WIDTH = 280;
export const MIN_WIDTH = 180;
export const MAX_WIDTH = 520;

export const clampWidth = (w: number): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

const storageKey = (page: EntryScope): string =>
  `harness.files.${page.scope}.${"id" in page ? page.id : "-"}`;

const isRoot = (v: unknown): v is RootId =>
  v === "session" || v === "project" || v === "global";

function parseTab(v: unknown): TabState | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  if (
    (t.kind !== "file" && t.kind !== "preview") ||
    !isRoot(t.root) ||
    typeof t.key !== "string" ||
    typeof t.transient !== "boolean"
  )
    return null;
  return { kind: t.kind, root: t.root, key: t.key, transient: t.transient };
}

/** Reads what was saved for a page; anything unreadable is dropped. */
export function loadView(page: EntryScope): SavedView {
  const empty: SavedView = {
    tabs: [],
    active: null,
    expanded: {},
    width: DEFAULT_WIDTH,
    showDeleted: false,
  };
  try {
    const raw = localStorage.getItem(storageKey(page));
    if (!raw) return empty;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const tabs = Array.isArray(v.tabs)
      ? v.tabs.map(parseTab).filter((t): t is TabState => t !== null)
      : [];
    const expanded: Record<string, boolean> = {};
    if (typeof v.expanded === "object" && v.expanded !== null) {
      for (const [k, on] of Object.entries(v.expanded)) {
        if (typeof on === "boolean") expanded[k] = on;
      }
    }
    const active =
      typeof v.active === "string" && tabs.some((t) => tabId(t) === v.active)
        ? v.active
        : null;
    return {
      tabs,
      active,
      expanded,
      width: typeof v.width === "number" ? clampWidth(v.width) : DEFAULT_WIDTH,
      showDeleted: v.showDeleted === true,
    };
  } catch {
    return empty;
  }
}

export function saveView(page: EntryScope, view: SavedView): void {
  try {
    localStorage.setItem(storageKey(page), JSON.stringify(view));
  } catch {
    // storage unavailable; the view lasts until the page reloads
  }
}
