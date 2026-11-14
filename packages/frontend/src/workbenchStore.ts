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
} from "./explorer";
import {
  closeTarget,
  mayBeTransient,
  carryOver,
  SAVED_KINDS,
  type NewWorkbenchTab,
  type WorkbenchTab,
} from "./workbench";

/*
 * The workbench's tabs, the folders open in its tree and the width of its
 * sidebar, kept in a store so that the places that close tabs (a session or
 * a project going to the trash) can reach it. Saved to localStorage as the
 * Files and Structured Data views are, under the key
 * `harness.workbench.global.-`. The address decides which tab is active;
 * `active` here follows it, and is what is saved.
 */

const PAGE = { scope: "global" } as const;
const SETTINGS_KEY = "harness.workbench.settings";
const SIDEBAR_KEY = "harness.workbench.sidebar";

interface WorkbenchState {
  tabs: WorkbenchTab[];
  active: string | null;
  /** Tree nodes open or closed, by node id. */
  expanded: Record<string, boolean>;
  width: number;
  /** The chats tree is shown (on a wide screen). */
  sidebarOpen: boolean;
  /** The section of Settings last used, as an address. */
  settingsPath: string;

  /** Opens or activates a tab; `permanent` keeps it (a single click may not). */
  open: (tab: NewWorkbenchTab, permanent: boolean) => void;
  setActive: (id: string | null) => void;
  keep: (id: string) => void;
  /** Moves a tab to the place of the tab at `toIndex`. */
  move: (id: string, toIndex: number) => void;
  /** Closes tabs; returns where to go when the active tab was one of them. */
  close: (ids: readonly string[]) => string | null;
  setExpanded: (node: string, open: boolean) => void;
  setWidth: (width: number) => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsPath: (path: string) => void;
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
  // The project picked in the old navbar is not used any more.
  try {
    localStorage.removeItem("harness.pickedProject");
  } catch {
    // storage unavailable
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
      // Closing the active tab makes its neighbour active; if that one is
      // closed next, the loop aims at the one after it.
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
      // storage unavailable; the choice is kept until the page reloads
    }
    set({ sidebarOpen: open });
  },

  setSettingsPath: (path) => {
    try {
      localStorage.setItem(SETTINGS_KEY, path);
    } catch {
      // storage unavailable; the section is remembered until the page reloads
    }
    set({ settingsPath: path });
  },
}));

// What is remembered between visits.
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

// How the workbench changes the address, for the places that close tabs.
let navigator: ((path: string) => void) | null = null;
export const setWorkbenchNavigator = (
  fn: ((path: string) => void) | null,
): void => {
  navigator = fn;
};

/**
 * Closes tabs (a session or a project going to the trash) and shows the tab
 * that takes their place. False when none was open.
 */
export function closeTabsAndGo(ids: readonly string[]): boolean {
  const before = useWorkbench.getState().tabs.length;
  const to = useWorkbench.getState().close(ids);
  if (to !== null) navigator?.(to);
  return useWorkbench.getState().tabs.length !== before;
}
