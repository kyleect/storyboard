import {
  closeTab,
  tabId,
  type ExplorerTab,
  type SavedViewOf,
  type TabsOf,
} from "./explorer";

/*
 * What the chat workbench shares with its tests: which tabs there are, how an
 * address maps to a tab and back, which project "New chat" goes to, and which
 * tab to show after one closes. Pure, so it is tested without a DOM. The
 * rules for opening, keeping and closing tabs, and what is remembered
 * between visits, are those of `explorer.ts`.
 */

export const WORKBENCH_KINDS = [
  "chat",
  "sessions",
  "project",
  "project-files",
  "project-data",
  "agents",
  "skills",
  "files",
  "data",
  "workspaces",
  "errors",
  "settings",
] as const;

export type WorkbenchKind = (typeof WORKBENCH_KINDS)[number];

/**
 * Kinds that older versions saved and no longer exist: a project's Agents and
 * Skills pages are now the Agents and Skills page with the project as its
 * root. Saved tabs of these kinds are carried over (`carryOver`).
 */
export const LEGACY_KINDS = ["project-agents", "project-skills"] as const;
const CARRIED: Record<(typeof LEGACY_KINDS)[number], WorkbenchKind> = {
  "project-agents": "agents",
  "project-skills": "skills",
};
type SavedKind = WorkbenchKind | (typeof LEGACY_KINDS)[number];
export const SAVED_KINDS: readonly SavedKind[] = [
  ...WORKBENCH_KINDS,
  ...LEGACY_KINDS,
];

/** A saved view with its tabs of an old kind turned into tabs of today's. */
export function carryOver(
  view: SavedViewOf<ExplorerTab<SavedKind>>,
): SavedViewOf<WorkbenchTab> {
  const renamed = new Map<string, string>();
  const seen = new Set<string>();
  const tabs: WorkbenchTab[] = [];
  for (const t of view.tabs) {
    const kind =
      t.kind in CARRIED ? CARRIED[t.kind as keyof typeof CARRIED] : t.kind;
    const next = { ...t, kind: kind as WorkbenchKind };
    renamed.set(tabId(t), tabId(next));
    if (seen.has(tabId(next))) continue;
    seen.add(tabId(next));
    tabs.push(next);
  }
  return {
    ...view,
    tabs,
    active: view.active === null ? null : (renamed.get(view.active) ?? null),
  };
}
/**
 * A tab. `root` says what `key` is: "session" for a chat (its id), "project"
 * for the pages of a project (its id), "global" for the rest (`key` is empty).
 * A project's chats are listed on its own page; the Sessions tab is the table
 * of the chats that have no project.
 */
export type WorkbenchTab = ExplorerTab<WorkbenchKind>;
export type NewWorkbenchTab = Omit<WorkbenchTab, "transient">;

/** The kinds that open in italics until used; every page does. */
export const mayBeTransient = (): boolean => true;

const GLOBAL_PAGES: Record<string, WorkbenchKind> = {
  sessions: "sessions",
  agents: "agents",
  skills: "skills",
  files: "files",
  data: "data",
  workspaces: "workspaces",
  errors: "errors",
};

const PROJECT_PAGES: Record<string, WorkbenchKind> = {
  files: "project-files",
  agents: "agents",
  skills: "skills",
  data: "project-data",
};

const PROJECT_SUFFIX: Partial<Record<WorkbenchKind, string>> = {
  "project-files": "files",
  agents: "agents",
  skills: "skills",
  "project-data": "data",
};

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The tab an address belongs to; null for an address that has none. */
export function tabForPath(pathname: string): NewWorkbenchTab | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  const [first, second, third] = parts;
  if (first === undefined) return null;
  if (first === "settings") {
    return { kind: "settings", root: "global", key: "" };
  }
  if (first === "sessions" && parts.length === 2 && second !== undefined) {
    const id = decode(second);
    return id ? { kind: "chat", root: "session", key: id } : null;
  }
  if (first === "projects" && second !== undefined) {
    const id = decode(second);
    if (!id) return null;
    if (parts.length === 2)
      return { kind: "project", root: "project", key: id };
    const kind = third === undefined ? undefined : PROJECT_PAGES[third];
    if (parts.length === 3 && kind) return { kind, root: "project", key: id };
    return null;
  }
  const kind = GLOBAL_PAGES[first];
  if (parts.length === 1 && kind) return { kind, root: "global", key: "" };
  return null;
}

/** The address of a tab; `/settings` is given the section last used. */
export function pathForTab(
  tab: Pick<WorkbenchTab, "kind" | "root" | "key">,
  settingsPath = "/settings",
): string {
  const id = encodeURIComponent(tab.key);
  switch (tab.kind) {
    case "chat":
      return `/sessions/${id}`;
    case "project":
      return `/projects/${id}`;
    case "settings":
      return settingsPath;
    case "sessions":
      return "/sessions";
    case "project-files":
    case "project-data":
      return `/projects/${id}/${PROJECT_SUFFIX[tab.kind]}`;
    // The Agents and Skills pages are one kind; the root says whose.
    case "agents":
    case "skills":
      return tab.root === "project"
        ? `/projects/${id}/${tab.kind}`
        : `/${tab.kind}`;
    default:
      return `/${tab.kind}`;
  }
}

/** The project a tab belongs to; null for a chat of no project or a global tab. */
export function projectOfTab(
  tab: Pick<WorkbenchTab, "kind" | "root" | "key">,
  projectOfSession: (sessionId: string) => string | null,
): string | null {
  if (tab.root === "project") return tab.key;
  if (tab.kind === "chat") return projectOfSession(tab.key);
  return null;
}

/**
 * The project "New chat" starts a session in: the focused row of the tree
 * (a project row, or a chat or page row under it; `projectId` null for the
 * "No project" group); with no row focused, the project of the active tab;
 * with neither, no project.
 */
export function newChatTarget(input: {
  focused: { projectId: string | null } | null;
  active: WorkbenchTab | null;
  projectOfSession: (sessionId: string) => string | null;
}): string | null {
  if (input.focused) return input.focused.projectId;
  if (input.active) return projectOfTab(input.active, input.projectOfSession);
  return null;
}

/** Where to go once `closedId` is closed: the tab that becomes active, or `/`. */
export function closeTarget<T extends WorkbenchTab>(
  state: TabsOf<T>,
  closedId: string,
  settingsPath = "/settings",
): string {
  const next = closeTab(state, closedId);
  const tab = next.tabs.find((t) => tabId(t) === next.active);
  return tab ? pathForTab(tab, settingsPath) : "/";
}

/** The ids of the tabs to close when a session goes to the trash. */
export function tabsForSession(
  tabs: readonly WorkbenchTab[],
  sessionId: string,
): string[] {
  return tabs
    .filter((t) => t.kind === "chat" && t.key === sessionId)
    .map(tabId);
}

/**
 * The ids of the tabs to close when a project goes to the trash: its pages,
 * and the chats of its sessions.
 */
export function tabsForProject(
  tabs: readonly WorkbenchTab[],
  projectId: string,
  projectOfSession: (sessionId: string) => string | null,
): string[] {
  return tabs
    .filter((t) =>
      t.kind === "chat"
        ? projectOfSession(t.key) === projectId
        : t.root === "project" && t.key === projectId,
    )
    .map(tabId);
}
