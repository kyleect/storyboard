import type { DataOwner, FileScope } from "../api";
import { profileSuffix } from "../stores/profile";

export type RootId = string;

export type FileRootId = "session" | "project" | "global";

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

const RANK: Record<DataOwner["scope"], number> = {
  agent: 1,
  session: 1,
  project: 2,
  global: 3,
};

export const rootLabel = (id: RootId): string =>
  isRootId(id) ? LABEL[id] : id;

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

export const isHigherScope = (target: DataOwner, page: DataOwner): boolean =>
  RANK[target.scope] > RANK[page.scope];

export const isRootId = (v: unknown): v is FileRootId =>
  v === "session" || v === "project" || v === "global";

export interface NodeRefOf<K extends string> {
  root: RootId;
  kind: K;
  path: string;
}

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

export interface TreeNode {
  label: string;
  value: string;
  children?: TreeNode[];
}

export interface ExplorerTab<K extends string = string> {
  kind: K;
  root: RootId;
  key: string;
  transient: boolean;
}

export const tabId = (
  t: Pick<ExplorerTab<string>, "kind" | "root" | "key">,
): string => `${t.kind}|${t.root}|${t.key}`;

export interface TabsOf<T extends ExplorerTab<string>> {
  tabs: T[];
  active: string | null;
}

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

export type PageKey = FileScope | string;

const storageKey = (namespace: string, page: PageKey): string =>
  (typeof page === "string"
    ? `harness.${namespace}.${page}`
    : `harness.${namespace}.${page.scope}.${"id" in page ? page.id : "-"}`) +
  profileSuffix();

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
    // storage can be unavailable
  }
}
