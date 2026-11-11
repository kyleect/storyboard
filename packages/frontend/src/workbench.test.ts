import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewIn, saveViewIn, tabId } from "./explorer";
import {
  closeTarget,
  newChatTarget,
  pathForTab,
  projectOfTab,
  tabForPath,
  tabsForProject,
  tabsForSession,
  WORKBENCH_KINDS,
  type WorkbenchTab,
} from "./workbench";

const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
};

const tab = (
  kind: WorkbenchTab["kind"],
  root: WorkbenchTab["root"],
  key = "",
): WorkbenchTab => ({ kind, root, key, transient: false });

const ROUTES = [
  "/sessions",
  "/sessions/s1",
  "/projects/p1",
  "/projects/p1/sessions",
  "/projects/p1/files",
  "/projects/p1/agents",
  "/projects/p1/skills",
  "/projects/p1/data",
  "/files",
  "/data",
  "/agents",
  "/skills",
  "/workspaces",
  "/errors",
  "/settings",
];

describe("tabForPath and pathForTab", () => {
  it("map every route to a tab and back", () => {
    for (const path of ROUTES) {
      const t = tabForPath(path);
      expect(t, path).not.toBeNull();
      expect(pathForTab(must(t)), path).toBe(path);
    }
  });

  it("uses a kind the workbench knows for every route", () => {
    for (const path of ROUTES) {
      expect(WORKBENCH_KINDS).toContain(must(tabForPath(path)).kind);
    }
  });

  it("tells the sessions of a project from those of no project", () => {
    expect(tabForPath("/sessions")).toEqual({
      kind: "sessions",
      root: "global",
      key: "",
    });
    expect(tabForPath("/projects/p1/sessions")).toEqual({
      kind: "sessions",
      root: "project",
      key: "p1",
    });
  });

  it("gives one settings tab whatever the section", () => {
    const a = tabForPath("/settings/general/models");
    const b = tabForPath("/settings/mcp/servers");
    expect(a).toEqual(b);
    expect(pathForTab(must(a), "/settings/mcp/servers")).toBe(
      "/settings/mcp/servers",
    );
  });

  it("finds no tab for the home page or an unknown address", () => {
    for (const path of [
      "/",
      "",
      "/nope",
      "/sessions/a/b",
      "/projects",
      "/projects/p1/nope",
      "/projects/p1/files/x",
      "/sessions/%E0%A4%A",
    ]) {
      expect(tabForPath(path), path).toBeNull();
    }
  });

  it("keeps ids with a bar, a slash or a space", () => {
    for (const id of ["a|b", "a/b", "a b", "100%"]) {
      const path = pathForTab(tab("chat", "session", id));
      expect(tabForPath(path)).toEqual({
        kind: "chat",
        root: "session",
        key: id,
      });
    }
  });

  it("ignores a trailing slash", () => {
    expect(tabForPath("/projects/p1/")).toEqual(tabForPath("/projects/p1"));
  });
});

describe("projectOfTab", () => {
  const of = (id: string) => (id === "s1" ? "p1" : null);

  it("takes a project page's project, a chat's, and none for the rest", () => {
    expect(projectOfTab(tab("project-data", "project", "p2"), of)).toBe("p2");
    expect(projectOfTab(tab("sessions", "project", "p2"), of)).toBe("p2");
    expect(projectOfTab(tab("chat", "session", "s1"), of)).toBe("p1");
    expect(projectOfTab(tab("chat", "session", "s2"), of)).toBeNull();
    expect(projectOfTab(tab("agents", "global"), of)).toBeNull();
    expect(projectOfTab(tab("sessions", "global"), of)).toBeNull();
  });
});

describe("newChatTarget", () => {
  const of = (id: string) => (id === "s1" ? "p1" : null);
  const base = { projectOfSession: of };

  it("uses the focused row first, even over the active tab", () => {
    expect(
      newChatTarget({
        ...base,
        focused: { projectId: "p2" },
        active: tab("chat", "session", "s1"),
      }),
    ).toBe("p2");
  });

  it("makes a standalone chat when the No project group is focused", () => {
    expect(
      newChatTarget({
        ...base,
        focused: { projectId: null },
        active: tab("project", "project", "p1"),
      }),
    ).toBeNull();
  });

  it("falls back to the active tab's project", () => {
    expect(
      newChatTarget({
        ...base,
        focused: null,
        active: tab("chat", "session", "s1"),
      }),
    ).toBe("p1");
    expect(
      newChatTarget({
        ...base,
        focused: null,
        active: tab("project-agents", "project", "p3"),
      }),
    ).toBe("p3");
  });

  it("makes a standalone chat with a global tab or nothing", () => {
    expect(
      newChatTarget({
        ...base,
        focused: null,
        active: tab("agents", "global"),
      }),
    ).toBeNull();
    expect(newChatTarget({ ...base, focused: null, active: null })).toBeNull();
  });
});

describe("closeTarget", () => {
  const tabs = [
    tab("chat", "session", "a"),
    tab("agents", "global"),
    tab("project", "project", "p"),
  ];
  const state = (active: string | null) => ({ tabs, active });

  it("goes to the next tab, else the one before", () => {
    expect(closeTarget(state(tabId(must(tabs[0]))), tabId(must(tabs[0])))).toBe(
      "/agents",
    );
    expect(closeTarget(state(tabId(must(tabs[1]))), tabId(must(tabs[1])))).toBe(
      "/projects/p",
    );
    expect(closeTarget(state(tabId(must(tabs[2]))), tabId(must(tabs[2])))).toBe(
      "/agents",
    );
  });

  it("goes home when the last tab closes", () => {
    const only = { tabs: [must(tabs[0])], active: tabId(must(tabs[0])) };
    expect(closeTarget(only, tabId(must(tabs[0])))).toBe("/");
  });

  it("uses the settings section last used", () => {
    const s = [tab("settings", "global"), tab("chat", "session", "a")];
    expect(
      closeTarget(
        { tabs: s, active: tabId(must(s[1])) },
        tabId(must(s[1])),
        "/settings/x",
      ),
    ).toBe("/settings/x");
  });
});

describe("tabsForSession and tabsForProject", () => {
  const tabs = [
    tab("chat", "session", "s1"),
    tab("chat", "session", "s2"),
    tab("project", "project", "p1"),
    tab("project-files", "project", "p1"),
    tab("project", "project", "p2"),
    tab("sessions", "global"),
  ];
  const of = (id: string) => (id === "s1" ? "p1" : null);

  it("finds the chat of a session", () => {
    expect(tabsForSession(tabs, "s2")).toEqual(["chat|session|s2"]);
    expect(tabsForSession(tabs, "none")).toEqual([]);
  });

  it("finds a project's pages and the chats of its sessions", () => {
    expect(tabsForProject(tabs, "p1", of)).toEqual([
      "chat|session|s1",
      "project|project|p1",
      "project-files|project|p1",
    ]);
    expect(tabsForProject(tabs, "p9", of)).toEqual([]);
  });
});

describe("the saved view", () => {
  // This test file runs in Node, which has no localStorage.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips, and drops a tab of a kind it does not know", () => {
    const view = {
      tabs: [tab("chat", "session", "s1"), tab("agents", "global")],
      active: "agents|global|",
      expanded: { p1: true },
      width: 300,
      showDeleted: false,
    };
    saveViewIn("workbench", { scope: "global" }, view);
    expect(
      loadViewIn("workbench", { scope: "global" }, WORKBENCH_KINDS),
    ).toEqual(view);
    saveViewIn("workbench", { scope: "global" }, {
      ...view,
      tabs: [
        ...view.tabs,
        { kind: "old", root: "global", key: "", transient: false },
      ],
    } as never);
    expect(
      loadViewIn("workbench", { scope: "global" }, WORKBENCH_KINDS).tabs,
    ).toHaveLength(2);
  });
});
