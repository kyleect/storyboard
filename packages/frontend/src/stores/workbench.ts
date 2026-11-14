import { create } from "zustand";
import {
  clampWidth,
  closeTab,
  moveTab,
  DEFAULT_WIDTH,
  keepTab,
  loadViewIn,
  openTabIn,
  saveViewIn,
} from "../lib/explorer";
import {
  closeTarget,
  mayBeTransient,
  carryOver,
  SAVED_KINDS,
  type NewWorkbenchTab,
  type WorkbenchTab,
} from "../lib/workbench";

const PAGE = { scope: "global" } as const;
const SETTINGS_KEY = "harness.workbench.settings";
const SIDEBAR_KEY = "harness.workbench.sidebar";

interface WorkbenchState {
  tabs: WorkbenchTab[];
  active: string | null;
  expanded: Record<string, boolean>;
  width: number;
  sidebarOpen: boolean;
  settingsPath: string;

  open: (tab: NewWorkbenchTab, permanent: boolean) => void;
  setActive: (id: string | null) => void;
  keep: (id: string) => void;
  move: (id: string, toIndex: number) => void;
  close: (ids: readonly string[]) => string | null;
  setExpanded: (node: string, open: boolean) => void;
  setWidth: (width: number) => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsPath: (path: string) => void;
  reload: () => void;
}

function loadSettingsPath(): string {
  try {
    return localStorage.getItem(SETTINGS_KEY) ?? "/settings";
  } catch {
    return "/settings";
  }
}

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

function initial() {
  try {
    localStorage.removeItem("harness.pickedProject");
  } catch {
    // storage can be unavailable
  }
  const view = carryOver(loadViewIn("workbench", PAGE, SAVED_KINDS));
  return {
    tabs: view.tabs,
    active: view.active,
    expanded: view.expanded,
    width: view.width,
    sidebarOpen: loadSidebarOpen(),
    settingsPath: loadSettingsPath(),
  };
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  ...initial(),

  open: (tab, permanent) =>
    set((s) => {
      const next = openTabIn(
        { tabs: s.tabs, active: s.active },
        tab,
        permanent,
        mayBeTransient,
      );
      return { tabs: next.tabs, active: next.active };
    }),

  setActive: (id) => set({ active: id }),

  keep: (id) =>
    set((s) => {
      const next = keepTab({ tabs: s.tabs, active: s.active }, id);
      return { tabs: next.tabs };
    }),

  move: (id, toIndex) =>
    set((s) => {
      const next = moveTab({ tabs: s.tabs, active: s.active }, id, toIndex);
      return next.tabs === s.tabs ? s : { tabs: next.tabs };
    }),

  close: (ids) => {
    const before = get();
    let state = { tabs: before.tabs, active: before.active };
    let go: string | null = null;
    for (const id of ids) {
      if (id === state.active) {
        go = closeTarget(state, id, before.settingsPath);
      }
      state = closeTab(state, id);
    }
    if (state.tabs.length === before.tabs.length) return null;
    set({ tabs: state.tabs, active: state.active });
    return go;
  },

  setExpanded: (node, open) =>
    set((s) => ({ expanded: { ...s.expanded, [node]: open } })),

  setWidth: (width) => set({ width: clampWidth(width) }),

  setSidebarOpen: (open) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
    } catch {
      // storage can be unavailable
    }
    set({ sidebarOpen: open });
  },

  setSettingsPath: (path) => {
    try {
      localStorage.setItem(SETTINGS_KEY, path);
    } catch {
      // storage can be unavailable
    }
    set({ settingsPath: path });
  },

  reload: () => set(initial()),
}));

useWorkbench.subscribe((s, prev) => {
  if (
    s.tabs === prev.tabs &&
    s.active === prev.active &&
    s.expanded === prev.expanded &&
    s.width === prev.width
  )
    return;
  saveViewIn("workbench", PAGE, {
    tabs: s.tabs,
    active: s.active,
    expanded: s.expanded,
    width: s.width || DEFAULT_WIDTH,
    showDeleted: false,
  });
});

let navigator: ((path: string) => void) | null = null;
export const setWorkbenchNavigator = (
  fn: ((path: string) => void) | null,
): void => {
  navigator = fn;
};

export const navigateWorkbench = (path: string): void => navigator?.(path);

export function closeTabsAndGo(ids: readonly string[]): boolean {
  const before = useWorkbench.getState().tabs.length;
  const to = useWorkbench.getState().close(ids);
  if (to !== null) navigator?.(to);
  return useWorkbench.getState().tabs.length !== before;
}
