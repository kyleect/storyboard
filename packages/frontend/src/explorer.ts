import type { DataOwner, FileScope } from "./api";

/*
 * What the editor-style explorers share: the Files view
 * (`files-explorer.ts`) and the Structured Data view
 * (`structured-explorer.ts`). Which roots a page shows, how a tree node is
 * named, the rules for opening and closing tabs, and what is remembered
 * between visits. Pure, so it is tested without a DOM.
 */

/**
 * A root folder in a tree. Files and Structured Data have three, below; other
 * explorers (skills) bring their own, so the id is any string their caller
 * chooses and keeps unique within one tree.
 */
export type RootId = string;

/** The three places files and structured data live. */
export type FileRootId = "session" | "project" | "global";

/**
 * A root folder: its id, what owns what it holds and its name. Files have a
 * file scope for an owner; Structured Data also takes an agent's.
 */
export interface Root<S extends DataOwner = FileScope> {
  id: RootId;
  scope: S;
  label: string;
}

const LABEL: Record<FileRootId, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
};

/**
 * Global is above project, which is above session. An agent's own sits with
 * the session: nothing it holds is shared further than the agent itself.
 */
const RANK: Record<DataOwner["scope"], number> = {
  agent: 1,
  session: 1,
  project: 2,
  global: 3,
};

/** The name of a file root; any other root is named by whoever made it. */
export const rootLabel = (id: RootId): string =>
  isRootId(id) ? LABEL[id] : id;

/**
 * The roots a page shows: what is available at its scope. A session sees
 * its own, its project's (when it has one) and the global ones; a project
 * sees its own and the global ones; the global page sees only the global
 * ones.
 */
export function rootsFor(
  page: FileScope,
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
export const isHigherScope = (target: DataOwner, page: DataOwner): boolean =>
  RANK[target.scope] > RANK[page.scope];

export const isRootId = (v: unknown): v is FileRootId =>
  v === "session" || v === "project" || v === "global";

// ---------------------------------------------------------------- tree nodes

export interface NodeRefOf<K extends string> {
  root: RootId;
  kind: K;
  /** Empty for a root. */
  path: string;
}

/** A tree node's value: root, kind and path (the path may hold "|"). */
export const nodeValue = (r: NodeRefOf<string>): string =>
  `${r.root}|${r.kind}|${r.path}`;

export function parseNodeValueOf(value: string): NodeRefOf<string> {
  const first = value.indexOf("|");
  const second = value.indexOf("|", first + 1);
  return {
    root: value.slice(0, first) as RootId,
    kind: value.slice(first + 1, second),
    path: value.slice(second + 1),
  };
}

/** A node of the tree the explorers show. */
export interface TreeNode {
  label: string;
  value: string;
  children?: TreeNode[];
}

// ----------------------------------------------------------------- the tabs

/** A tab: what it shows (`kind`), where (`root`) and which one (`key`). */
export interface ExplorerTab<K extends string = string> {
  kind: K;
  root: RootId;
  key: string;
  /** Shown in italics; the next single click replaces it. */
  transient: boolean;
}

export const tabId = (
  t: Pick<ExplorerTab<string>, "kind" | "root" | "key">,
): string => `${t.kind}|${t.root}|${t.key}`;

export interface TabsOf<T extends ExplorerTab<string>> {
  tabs: T[];
  active: string | null;
}

/**
 * Opens a tab. A tab already open is activated, and kept when `permanent`.
 * A new tab opened by a single click, when its kind may be transient, takes
 * the place of the open transient tab, if there is one.
 */
export function openTabIn<T extends ExplorerTab<string>>(
  state: TabsOf<T>,
  tab: Omit<T, "transient">,
  permanent: boolean,
  mayBeTransient: (kind: T["kind"]) => boolean,
): TabsOf<T> {
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
  const added = {
    ...tab,
    transient: mayBeTransient(tab.kind) && !permanent,
  } as T;
  const at = added.transient ? state.tabs.findIndex((t) => t.transient) : -1;
  const tabs =
    at >= 0
      ? state.tabs.map((t, i) => (i === at ? added : t))
      : [...state.tabs, added];
  return { tabs, active: id };
}

/** Makes a tab permanent, as editing it does. */
export function keepTab<T extends ExplorerTab<string>>(
  state: TabsOf<T>,
  id: string,
): TabsOf<T> {
  if (!state.tabs.some((t) => tabId(t) === id && t.transient)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      tabId(t) === id ? { ...t, transient: false } : t,
    ),
  };
}

/**
 * Moves a tab to `toIndex`, counted among the tabs as they are now (the index
 * of the tab it is dropped on). The active tab stays active.
 */
export function moveTab<T extends ExplorerTab<string>>(
  state: TabsOf<T>,
  id: string,
  toIndex: number,
): TabsOf<T> {
  const from = state.tabs.findIndex((t) => tabId(t) === id);
  if (from < 0) return state;
  const to = Math.min(state.tabs.length - 1, Math.max(0, toIndex));
  if (to === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  if (moved === undefined) return state;
  tabs.splice(to, 0, moved);
  return { tabs, active: state.active };
}

/** Closes a tab; the next one to the right, else the left, becomes active. */
export function closeTab<T extends ExplorerTab<string>>(
  state: TabsOf<T>,
  id: string,
): TabsOf<T> {
  const at = state.tabs.findIndex((t) => tabId(t) === id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((_, i) => i !== at);
  if (state.active !== id) return { tabs, active: state.active };
  const next = tabs[at] ?? tabs[at - 1];
  return { tabs, active: next ? tabId(next) : null };
}

// -------------------------------------------------- remembered between visits

export interface SavedViewOf<T extends ExplorerTab<string>> {
  tabs: T[];
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

/** What a page is remembered under: a file scope, or any other page's own key. */
export type PageKey = FileScope | string;

const storageKey = (namespace: string, page: PageKey): string =>
  typeof page === "string"
    ? `harness.${namespace}.${page}`
    : `harness.${namespace}.${page.scope}.${"id" in page ? page.id : "-"}`;

function parseTab<K extends string>(
  v: unknown,
  kinds: readonly K[],
  isRoot: (v: unknown) => boolean,
): ExplorerTab<K> | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const kind = kinds.find((k) => k === t.kind);
  if (
    kind === undefined ||
    typeof t.root !== "string" ||
    !isRoot(t.root) ||
    typeof t.key !== "string" ||
    typeof t.transient !== "boolean"
  )
    return null;
  return { kind, root: t.root, key: t.key, transient: t.transient };
}

/**
 * Reads what was saved for a page under `namespace`; anything unreadable is
 * dropped, and tabs of a kind not in `kinds` too, or of a root `isRoot`
 * refuses (the file roots when it is left out).
 */
export function loadViewIn<K extends string>(
  namespace: string,
  page: PageKey,
  kinds: readonly K[],
  isRoot: (v: unknown) => boolean = isRootId,
): SavedViewOf<ExplorerTab<K>> {
  const empty: SavedViewOf<ExplorerTab<K>> = {
    tabs: [],
    active: null,
    expanded: {},
    width: DEFAULT_WIDTH,
    showDeleted: false,
  };
  try {
    const raw = localStorage.getItem(storageKey(namespace, page));
    if (!raw) return empty;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const tabs = Array.isArray(v.tabs)
      ? v.tabs
          .map((t) => parseTab(t, kinds, isRoot))
          .filter((t): t is ExplorerTab<K> => t !== null)
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

export function saveViewIn<T extends ExplorerTab<string>>(
  namespace: string,
  page: PageKey,
  view: SavedViewOf<T>,
): void {
  try {
    localStorage.setItem(storageKey(namespace, page), JSON.stringify(view));
  } catch {
    // storage unavailable; the view lasts until the page reloads
  }
}
