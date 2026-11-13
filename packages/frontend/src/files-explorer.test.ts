import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFile } from "./api";
import {
  buildTree,
  closeTab,
  emptyValueFor,
  isHigherScope,
  loadView,
  mediaTypeForName,
  nodeValue,
  openTab,
  parseNodeValue,
  renameFolderInTabs,
  rootsFor,
  saveView,
  tabId,
  type TabsState,
  type TreeNode,
} from "./files-explorer";

/** A value a test needs to be there; says so if it is not. */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const nth = (nodes: TreeNode[] | undefined, i: number): TreeNode =>
  must(nodes?.[i]);

const file = (key: string, extra: Partial<StoredFile> = {}): StoredFile => ({
  key,
  mediaType: "text/plain",
  value: "",
  updatedAt: "2026-11-11T00:00:00Z",
  deleted: false,
  ...extra,
});

describe("rootsFor", () => {
  it("gives a session its own, its project's and the global files", () => {
    const roots = rootsFor({ scope: "session", id: "s1" }, "p1");
    expect(roots.map((r) => r.id)).toEqual(["session", "project", "global"]);
    expect(roots[1]?.scope).toEqual({ scope: "project", id: "p1" });
  });

  it("gives a standalone session no project root", () => {
    const roots = rootsFor({ scope: "session", id: "s1" }, null);
    expect(roots.map((r) => r.id)).toEqual(["session", "global"]);
  });

  it("gives a project its own and the global files, and the global page only its own", () => {
    expect(
      rootsFor({ scope: "project", id: "p1" }, undefined).map((r) => r.id),
    ).toEqual(["project", "global"]);
    expect(rootsFor({ scope: "global" }, undefined).map((r) => r.id)).toEqual([
      "global",
    ]);
  });
});

describe("isHigherScope", () => {
  const session = { scope: "session", id: "s1" } as const;
  const project = { scope: "project", id: "p1" } as const;
  const global = { scope: "global" } as const;
  it("ranks global over project over session", () => {
    expect(isHigherScope(global, session)).toBe(true);
    expect(isHigherScope(project, session)).toBe(true);
    expect(isHigherScope(global, project)).toBe(true);
  });
  it("is false for the page's own scope or a lower one", () => {
    expect(isHigherScope(session, session)).toBe(false);
    expect(isHigherScope(project, global)).toBe(false);
    expect(isHigherScope(session, project)).toBe(false);
  });
});

describe("new files", () => {
  it("takes the type from the extension", () => {
    expect(mediaTypeForName("a/notes.md")).toBe("text/markdown");
    expect(mediaTypeForName("README.MARKDOWN")).toBe("text/markdown");
    expect(mediaTypeForName("cfg.json")).toBe("application/json");
    expect(mediaTypeForName("story.txt")).toBe("text/plain");
    expect(mediaTypeForName("noextension")).toBe("text/plain");
  });
  it("starts JSON as an object, because JSON must parse", () => {
    expect(emptyValueFor("application/json")).toBe("{}");
    expect(emptyValueFor("text/markdown")).toBe("");
  });
});

describe("node values", () => {
  it("round-trip, including a path that holds a bar", () => {
    const ref = { root: "project", kind: "file", path: "a|b/c.md" } as const;
    expect(parseNodeValue(nodeValue(ref))).toEqual(ref);
    const root = { root: "global", kind: "root", path: "" } as const;
    expect(parseNodeValue(nodeValue(root))).toEqual(root);
  });
});

describe("buildTree", () => {
  const roots = rootsFor({ scope: "session", id: "s1" }, "p1");
  const names = (nodes: TreeNode[] | undefined) =>
    (nodes ?? []).map((n) => n.label);

  it("makes a root folder for each root, with folders before files, by name", () => {
    const { data } = buildTree(
      [
        {
          root: must(roots[0]),
          files: [
            file("b.md"),
            file("a.md"),
            file("drafts/ch2.md"),
            file("drafts/ch10.md"),
            file("drafts/sub/x.md"),
          ],
          folders: ["empty"],
        },
        { root: must(roots[1]), files: [], folders: [] },
        { root: must(roots[2]), files: [file("g.txt")], folders: [] },
      ],
      null,
    );
    expect(names(data)).toEqual(["Session", "Project", "Global"]);
    const session = nth(data, 0);
    expect(names(session.children)).toEqual([
      "drafts",
      "empty",
      "a.md",
      "b.md",
    ]);
    const drafts = nth(session.children, 0);
    // Numeric-aware: ch2 before ch10.
    expect(names(drafts.children)).toEqual(["sub", "ch2.md", "ch10.md"]);
    expect(names(nth(data, 2).children)).toEqual(["g.txt"]);
  });

  it("shows the folders above a folder that was made without them", () => {
    const { data } = buildTree(
      [{ root: must(roots[0]), files: [], folders: ["a/b"] }],
      null,
    );
    expect(names(nth(data, 0).children)).toEqual(["a"]);
    expect(names(nth(nth(data, 0).children, 0).children)).toEqual(["b"]);
  });

  it("records what a row needs, deleted files included", () => {
    const { data, info } = buildTree(
      [
        {
          root: must(roots[0]),
          files: [
            file("old.md", { mediaType: "text/markdown", deleted: true }),
          ],
          folders: [],
        },
      ],
      null,
    );
    const value = nth(nth(data, 0).children, 0).value;
    expect(info.get(value)).toEqual({
      name: "old.md",
      deleted: true,
      mediaType: "text/markdown",
    });
  });

  it("puts a pending name box first in its folder", () => {
    const { data } = buildTree(
      [{ root: must(roots[0]), files: [file("drafts/a.md")], folders: [] }],
      { kind: "new-file", root: "session", parent: "drafts" },
    );
    const drafts = nth(nth(data, 0).children, 0);
    expect(nth(drafts.children, 0).value).toBe(
      nodeValue({ root: "session", kind: "new-file", path: "drafts" }),
    );
    expect(names(drafts.children)).toEqual(["", "a.md"]);
  });
});

describe("tabs", () => {
  const empty: TabsState = { tabs: [], active: null };
  const a = { kind: "file", root: "session", key: "a.md" } as const;
  const b = { kind: "file", root: "session", key: "b.md" } as const;
  const c = { kind: "file", root: "global", key: "c.md" } as const;

  it("opens a single click as a transient tab that the next one replaces", () => {
    let s = openTab(empty, a, false);
    expect(s.tabs).toEqual([{ ...a, transient: true }]);
    s = openTab(s, b, false);
    expect(s.tabs).toEqual([{ ...b, transient: true }]);
    expect(s.active).toBe(tabId(b));
  });

  it("keeps a tab opened by double click, and a transient tab opens beside it", () => {
    let s = openTab(empty, a, true);
    s = openTab(s, b, false);
    expect(s.tabs.map((t) => [t.key, t.transient])).toEqual([
      ["a.md", false],
      ["b.md", true],
    ]);
    s = openTab(s, c, false);
    expect(s.tabs.map((t) => t.key)).toEqual(["a.md", "c.md"]);
  });

  it("makes an open transient tab permanent when it is opened for good", () => {
    let s = openTab(empty, a, false);
    s = openTab(s, a, true);
    expect(s.tabs).toEqual([{ ...a, transient: false }]);
    expect(s.tabs).toHaveLength(1);
  });

  it("tells the same key in two roots apart", () => {
    const x = { ...a, root: "global" } as const;
    expect(tabId(a)).not.toBe(tabId(x));
  });

  it("makes a preview tab permanent from the start", () => {
    const s = openTab(empty, { ...a, kind: "preview" }, true);
    expect(s.tabs[0]?.transient).toBe(false);
    // And a single-click file open does not replace it.
    const t = openTab(s, b, false);
    expect(t.tabs).toHaveLength(2);
  });

  it("activates the tab to the right on close, else the left, else none", () => {
    let s = openTab(openTab(openTab(empty, a, true), b, true), c, true);
    s = { ...s, active: tabId(b) };
    s = closeTab(s, tabId(b));
    expect(s.active).toBe(tabId(c));
    s = closeTab(s, tabId(c));
    expect(s.active).toBe(tabId(a));
    s = closeTab(s, tabId(a));
    expect(s).toEqual({ tabs: [], active: null });
  });

  it("leaves the active tab alone when another one is closed", () => {
    let s = openTab(openTab(empty, a, true), b, true);
    s = closeTab(s, tabId(a));
    expect(s.active).toBe(tabId(b));
  });

  it("follows a folder rename in the keys of open tabs", () => {
    const inFolder = { kind: "file", root: "session", key: "d/x.md" } as const;
    const other = { kind: "file", root: "global", key: "d/x.md" } as const;
    let s = openTab(openTab(empty, inFolder, true), other, true);
    s = { ...s, active: tabId(inFolder) };
    const next = renameFolderInTabs(s, "session", "d", "e/f");
    expect(next.tabs.map((t) => [t.root, t.key])).toEqual([
      ["session", "e/f/x.md"],
      ["global", "d/x.md"],
    ]);
    expect(next.active).toBe(tabId({ ...inFolder, key: "e/f/x.md" }));
  });
});

describe("what is remembered", () => {
  const page = { scope: "session", id: "s1" } as const;
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

  it("starts empty", () => {
    expect(loadView(page)).toMatchObject({ tabs: [], active: null });
  });

  it("round-trips tabs, the active tab, the folders open, the width and show deleted", () => {
    const tabs = [
      { kind: "file", root: "session", key: "a.md", transient: false },
      { kind: "preview", root: "global", key: "b.md", transient: false },
    ] as const;
    saveView(page, {
      tabs: [...tabs],
      active: tabId(tabs[1]),
      expanded: { "session|root|": true },
      width: 300,
      showDeleted: true,
    });
    expect(loadView(page)).toEqual({
      tabs,
      active: tabId(tabs[1]),
      expanded: { "session|root|": true },
      width: 300,
      showDeleted: true,
    });
  });

  it("keeps each page's own", () => {
    saveView(page, {
      tabs: [],
      active: null,
      expanded: {},
      width: 400,
      showDeleted: false,
    });
    expect(loadView({ scope: "session", id: "s2" }).width).toBe(280);
  });

  it("drops anything unreadable and limits the width", () => {
    localStorage.setItem("harness.files.session.s1", "{not json");
    expect(loadView(page).tabs).toEqual([]);
    localStorage.setItem(
      "harness.files.session.s1",
      JSON.stringify({
        tabs: [
          { kind: "file", root: "session", key: "ok.md", transient: false },
          { kind: "nope", root: "session", key: "x", transient: false },
          { kind: "file", root: "elsewhere", key: "x", transient: false },
          "junk",
        ],
        active: "file|session|gone.md",
        width: 9999,
      }),
    );
    const view = loadView(page);
    expect(view.tabs.map((t) => t.key)).toEqual(["ok.md"]);
    expect(view.active).toBeNull();
    expect(view.width).toBe(520);
  });
});
