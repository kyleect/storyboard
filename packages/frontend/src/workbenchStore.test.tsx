import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTabsAndGo,
  setWorkbenchNavigator,
  useWorkbench,
} from "./workbenchStore";
import type { WorkbenchTab } from "./workbench";

/*
 * What a session or a project going to the trash does to the open tabs, and
 * what is kept between visits.
 */

const tab = (
  kind: WorkbenchTab["kind"],
  root: WorkbenchTab["root"],
  key = "",
): WorkbenchTab => ({ kind, root, key, transient: false });

const ids = () => useWorkbench.getState().tabs.map((t) => `${t.kind}:${t.key}`);

beforeEach(() => {
  localStorage.clear();
  setWorkbenchNavigator(null);
  useWorkbench.setState({
    tabs: [
      tab("chat", "session", "a"),
      tab("chat", "session", "b"),
      tab("agents", "global"),
    ],
    active: "chat|session|a",
    expanded: {},
    width: 280,
    settingsPath: "/settings",
  });
});

describe("closing tabs from outside the strip", () => {
  it("shows the neighbour when the active tab closes", () => {
    const go = vi.fn();
    setWorkbenchNavigator(go);
    expect(closeTabsAndGo(["chat|session|a"])).toBe(true);
    expect(ids()).toEqual(["chat:b", "agents:"]);
    expect(go).toHaveBeenCalledWith("/sessions/b");
  });

  it("aims past a neighbour that closes too", () => {
    const go = vi.fn();
    setWorkbenchNavigator(go);
    closeTabsAndGo(["chat|session|a", "chat|session|b"]);
    expect(ids()).toEqual(["agents:"]);
    expect(go).toHaveBeenLastCalledWith("/agents");
  });

  it("goes home when nothing is left", () => {
    const go = vi.fn();
    setWorkbenchNavigator(go);
    closeTabsAndGo(["chat|session|a", "chat|session|b", "agents|global|"]);
    expect(go).toHaveBeenLastCalledWith("/");
  });

  it("does not move the address when another tab closes", () => {
    const go = vi.fn();
    setWorkbenchNavigator(go);
    closeTabsAndGo(["chat|session|b"]);
    expect(go).not.toHaveBeenCalled();
    expect(useWorkbench.getState().active).toBe("chat|session|a");
  });

  it("says when there was nothing to close", () => {
    expect(closeTabsAndGo(["chat|session|zzz"])).toBe(false);
  });

  it("returns to the Settings section last used", () => {
    useWorkbench.setState({
      tabs: [tab("settings", "global"), tab("chat", "session", "a")],
      active: "chat|session|a",
      settingsPath: "/settings/mcp/servers",
    });
    const go = vi.fn();
    setWorkbenchNavigator(go);
    closeTabsAndGo(["chat|session|a"]);
    expect(go).toHaveBeenCalledWith("/settings/mcp/servers");
  });
});

describe("what is kept between visits", () => {
  it("saves the tabs, the open folders and the width", () => {
    useWorkbench.getState().setExpanded("project:p1", true);
    useWorkbench.getState().setWidth(9999);
    const saved = JSON.parse(
      localStorage.getItem("harness.workbench.global.-") ?? "{}",
    );
    expect(saved.expanded).toEqual({ "project:p1": true });
    expect(saved.width).toBe(520);
    expect(saved.tabs).toHaveLength(3);
  });

  it("removes the key of the old project picker", async () => {
    localStorage.setItem("harness.pickedProject", "p1");
    vi.resetModules();
    await import("./workbenchStore");
    expect(localStorage.getItem("harness.pickedProject")).toBeNull();
  });

  it("remembers the Settings section on its own", () => {
    useWorkbench.getState().setSettingsPath("/settings/general/prompts");
    expect(localStorage.getItem("harness.workbench.settings")).toBe(
      "/settings/general/prompts",
    );
  });
});
