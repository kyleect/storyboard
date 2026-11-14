import {
  closeTab,
  tabId,
  type ExplorerTab,
  type SavedViewOf,
  type TabsOf,
} from "./explorer";

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
export type WorkbenchTab = ExplorerTab<WorkbenchKind>;
export type NewWorkbenchTab = Omit<WorkbenchTab, "transient">;

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
    case "agents":
    case "skills":
      return tab.root === "project"
        ? `/projects/${id}/${tab.kind}`
        : `/${tab.kind}`;
    default:
      return `/${tab.kind}`;
  }
}

export function projectOfTab(
  tab: Pick<WorkbenchTab, "kind" | "root" | "key">,
  projectOfSession: (sessionId: string) => string | null,
): string | null {
  if (tab.root === "project") return tab.key;

  if (tab.kind === "chat") return projectOfSession(tab.key);

  return null;
}

export function newChatTarget(input: {
  focused: { projectId: string | null } | null;
  active: WorkbenchTab | null;
  projectOfSession: (sessionId: string) => string | null;
}): string | null {
  if (input.focused) return input.focused.projectId;

  if (input.active) return projectOfTab(input.active, input.projectOfSession);

  return null;
}

export function closeTarget<T extends WorkbenchTab>(
  state: TabsOf<T>,
  closedId: string,
  settingsPath = "/settings",
): string {
  const next = closeTab(state, closedId);
  const tab = next.tabs.find((t) => tabId(t) === next.active);

  return tab ? pathForTab(tab, settingsPath) : "/";
}

export function tabsForSession(
  tabs: readonly WorkbenchTab[],
  sessionId: string,
): string[] {
  return tabs
    .filter((t) => t.kind === "chat" && t.key === sessionId)
    .map(tabId);
}

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
