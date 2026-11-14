import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaInfo } from "@harness/core";
import type { DataItem, DataOwner } from "../api";
import {
  isHigherScope,
  nodeValue,
  rootsFor,
  tabId,
  type Root,
  type TreeNode,
} from "./explorer";
import {
  loadView as loadFilesView,
  saveView as saveFilesView,
} from "./files-explorer";
import {
  buildTree,
  isInherited,
  loadView,
  mergeSchemas,
  openTab,
  parseNodeValue,
  saveView,
  schemaTabRoot,
  scopeName,
  tabNode,
  type TabsState,
} from "./structured-explorer";

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const nth = (nodes: TreeNode[] | undefined, i: number): TreeNode =>
  must(nodes?.[i]);
const names = (nodes: TreeNode[] | undefined) =>
  (nodes ?? []).map((n) => n.label);

const schema = (id: string, extra: Partial<SchemaInfo> = {}): SchemaInfo => ({
  id,
  name: id,
  description: "d",
  scope: "session",
  version: 1,
  copiedFrom: null,
  deleted: false,
  ...extra,
});

const item = (id: string, schemaId: string, extra: Partial<DataItem> = {}) =>
  ({
    id,
    name: id,
    description: "d",
    scope: "session",
    schemaId,
    schemaVersion: 1,
    latestVersion: 1,
    outOfDate: false,
    schemaInScope: true,
    deleted: false,
    ...extra,
  }) satisfies DataItem;

const roots = rootsFor({ scope: "session", id: "s1" }, "p1");
const root = (i: number) => must(roots[i]);

describe("buildTree", () => {
  it("makes a root for each scope, each with a Schemas folder", () => {
    const { data } = buildTree(
      roots.map((r) => ({ root: r, schemas: [], data: [] })),
      null,
    );
    expect(names(data)).toEqual(["Session", "Project", "Global"]);
    for (const top of data) expect(names(top.children)).toEqual(["Schemas"]);
  });

  it("puts a root's schemas, by name, in its Schemas folder, with their data under them", () => {
    const { data } = buildTree(
      [
        {
          root: root(0),
          schemas: [schema("Setting"), schema("Character")],
          data: [
            item("Bram", "Character"),
            item("Aria", "Character"),
            item("Cove", "Setting"),
          ],
        },
      ],
      null,
    );
    const folder = nth(nth(data, 0).children, 0);
    expect(names(folder.children)).toEqual(["Character", "Setting"]);
    expect(names(nth(folder.children, 0).children)).toEqual(["Aria", "Bram"]);
    expect(names(nth(folder.children, 1).children)).toEqual(["Cove"]);
  });

  it("marks a schema from a higher scope as inherited, and not its own", () => {
    const { data, info } = buildTree(
      [
        {
          root: root(0),
          schemas: [
            schema("Mine"),
            schema("Shared", { scope: "global" }),
            schema("Project's", { scope: "project" }),
            schema("Comes with the app", { scope: "builtin" }),
          ],
          data: [],
        },
      ],
      null,
    );
    const rows = nth(nth(data, 0).children, 0).children ?? [];
    const flag = (label: string) =>
      info.get(must(rows.find((r) => r.label === label)).value)?.inherited;
    expect(flag("Mine")).toBe(false);
    expect(flag("Shared")).toBe(true);
    expect(flag("Project's")).toBe(true);
    expect(flag("Comes with the app")).toBe(true);
    expect(
      info.get(must(rows.find((r) => r.label === "Shared")).value)?.schemaScope,
    ).toBe("global");
  });

  it("shows a global schema as its own under the Global root", () => {
    expect(isInherited(schema("g", { scope: "global" }), root(2))).toBe(false);
    expect(isInherited(schema("g", { scope: "global" }), root(0))).toBe(true);
  });

  it("shows the same schema under every root that can use it, with each root's own data", () => {
    const shared = schema("Setting", { scope: "global" });
    const { data } = buildTree(
      [
        {
          root: root(0),
          schemas: [shared],
          data: [item("Cove", "Setting")],
        },
        {
          root: root(2),
          schemas: [shared],
          data: [item("Harbour", "Setting", { scope: "global" })],
        },
      ],
      null,
    );
    const underSession = nth(nth(nth(data, 0).children, 0).children, 0);
    const underGlobal = nth(nth(nth(data, 1).children, 0).children, 0);
    expect(names(underSession.children)).toEqual(["Cove"]);
    expect(names(underGlobal.children)).toEqual(["Harbour"]);
    expect(underSession.value).not.toBe(underGlobal.value);
  });

  it("puts data whose schema is not available under Unknown schema, last", () => {
    const { data, info } = buildTree(
      [
        {
          root: root(0),
          schemas: [schema("Zebra")],
          data: [
            item("Lost", "gone", { schemaInScope: false }),
            item("Z1", "Zebra"),
          ],
        },
      ],
      null,
    );
    const folder = nth(nth(data, 0).children, 0);
    expect(names(folder.children)).toEqual(["Zebra", "Unknown schema"]);
    const unknown = nth(folder.children, 1);
    expect(names(unknown.children)).toEqual(["Lost"]);
    expect(info.get(unknown.value)?.name).toBe("Unknown schema");
  });

  it("records what a row needs, deleted and out-of-date included", () => {
    const { data, info } = buildTree(
      [
        {
          root: root(0),
          schemas: [schema("S", { deleted: true })],
          data: [item("old", "S", { deleted: true, outOfDate: true })],
        },
      ],
      null,
    );
    const s = nth(nth(nth(data, 0).children, 0).children, 0);
    expect(info.get(s.value)?.deleted).toBe(true);
    expect(info.get(nth(s.children, 0).value)).toMatchObject({
      name: "old",
      deleted: true,
      outOfDate: true,
    });
  });

  it("puts a pending schema name box first in the Schemas folder", () => {
    const { data } = buildTree(
      [{ root: root(0), schemas: [schema("A")], data: [] }],
      { kind: "new-schema", root: "session" },
    );
    const folder = nth(nth(data, 0).children, 0);
    expect(nth(folder.children, 0).value).toBe(
      nodeValue({ root: "session", kind: "new-schema", path: "" }),
    );
    expect(names(folder.children)).toEqual(["", "A"]);
  });

  it("puts a pending data name box first under its schema", () => {
    const { data } = buildTree(
      [
        {
          root: root(0),
          schemas: [schema("A")],
          data: [item("one", "A")],
        },
      ],
      { kind: "new-data", root: "session", schemaId: "A" },
    );
    const a = nth(nth(nth(data, 0).children, 0).children, 0);
    expect(nth(a.children, 0).value).toBe(
      nodeValue({ root: "session", kind: "new-data", path: "A" }),
    );
    expect(names(a.children)).toEqual(["", "one"]);
  });

  it("shows no name box under another root", () => {
    const { data } = buildTree(
      [
        { root: root(0), schemas: [], data: [] },
        { root: root(2), schemas: [], data: [] },
      ],
      { kind: "new-schema", root: "global" },
    );
    expect(names(nth(nth(data, 0).children, 0).children)).toEqual([]);
    expect(names(nth(nth(data, 1).children, 0).children)).toEqual([""]);
  });
});

describe("mergeSchemas", () => {
  it("gives one file per schema, the root's own list winning", () => {
    const merged = mergeSchemas(
      [schema("a", { deleted: true })],
      [schema("a"), schema("b")],
    );
    expect(merged.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(must(merged.find((s) => s.id === "a")).deleted).toBe(true);
  });
});

describe("with an agent's root", () => {
  const agent: Root<DataOwner> = {
    id: "agent",
    scope: { scope: "agent", id: "a1" },
    label: "Agent",
  };

  it("keeps the agent's own schemas its own, and the others' inherited", () => {
    expect(isInherited(schema("a", { scope: "agent" }), agent)).toBe(false);
    expect(isInherited(schema("p", { scope: "project" }), agent)).toBe(true);
    expect(isInherited(schema("g", { scope: "global" }), agent)).toBe(true);
    expect(isInherited(schema("b", { scope: "builtin" }), agent)).toBe(true);
  });

  it("opens every schema in the agent's root when it is the only one", () => {
    for (const scope of ["agent", "project", "global", "builtin"] as const)
      expect(schemaTabRoot(scope, "agent", [agent])).toBe("agent");
  });

  it("does not rank the agent's own above the page it is on", () => {
    expect(isHigherScope(agent.scope, agent.scope)).toBe(false);
    expect(isHigherScope(agent.scope, { scope: "session", id: "s" })).toBe(
      false,
    );
    expect(isHigherScope({ scope: "global" }, agent.scope)).toBe(true);
  });
});

describe("where a schema's tab belongs", () => {
  it("is the root of the scope it lives in, wherever it was opened from", () => {
    expect(schemaTabRoot("global", "session", roots)).toBe("global");
    expect(schemaTabRoot("project", "session", roots)).toBe("project");
    expect(schemaTabRoot("session", "session", roots)).toBe("session");
  });
  it("is Global for a built-in schema, and the opening root for an agent's", () => {
    expect(schemaTabRoot("builtin", "session", roots)).toBe("global");
    expect(schemaTabRoot("agent", "project", roots)).toBe("project");
  });
  it("names scopes for people", () => {
    expect(scopeName("global")).toBe("Global");
    expect(scopeName("builtin")).toBe("Built-in");
  });
});

describe("node values", () => {
  it("round-trip, including an id that holds a bar", () => {
    const ref = { root: "project", kind: "data", path: "a|b" } as const;
    expect(parseNodeValue(nodeValue(ref))).toEqual(ref);
  });
});

describe("tabs", () => {
  const empty: TabsState = { tabs: [], active: null };
  const a = { kind: "schema", root: "session", key: "a" } as const;
  const b = { kind: "data", root: "session", key: "b" } as const;

  it("opens a single click as a transient tab that the next one replaces", () => {
    let s = openTab(empty, a, false);
    expect(s.tabs).toEqual([{ ...a, transient: true }]);
    s = openTab(s, b, false);
    expect(s.tabs).toEqual([{ ...b, transient: true }]);
    expect(s.active).toBe(tabId(b));
  });

  it("keeps a tab opened by double click", () => {
    let s = openTab(empty, a, true);
    s = openTab(s, b, false);
    expect(s.tabs.map((t) => [t.key, t.transient])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("tells a schema and data with the same id apart", () => {
    expect(tabId(a)).not.toBe(tabId({ ...a, kind: "data" }));
  });

  it("points at the tree node of the tab", () => {
    expect(tabNode({ ...b, transient: false })).toBe("session|data|b");
  });
});

describe("what is remembered", () => {
  const page = { scope: "session", id: "s1" } as const;
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

  it("remembers a view under a key of its own, for the roots the caller names", () => {
    const tab = {
      kind: "schema",
      root: "agent",
      key: "sa",
      transient: false,
    } as const;
    saveView("agent.a1", {
      tabs: [tab],
      active: tabId(tab),
      expanded: {},
      width: 280,
      showDeleted: false,
    });
    expect(loadView("agent.a1").tabs).toEqual([]);
    expect(loadView("agent.a1", (r) => r === "agent").tabs).toEqual([tab]);
  });

  it("round-trips tabs, the active tab, open folders, width and show deleted", () => {
    const tabs = [
      { kind: "schema", root: "global", key: "s", transient: false },
      { kind: "data", root: "session", key: "d", transient: false },
    ] as const;
    const view = {
      tabs: [...tabs],
      active: tabId(tabs[1]),
      expanded: { "session|root|": true },
      width: 300,
      showDeleted: true,
    };
    saveView(page, view);
    expect(loadView(page)).toEqual({ ...view, tabs });
  });

  it("keeps it apart from what the Files view remembers for the same page", () => {
    saveView(page, {
      tabs: [{ kind: "data", root: "session", key: "d", transient: false }],
      active: null,
      expanded: {},
      width: 333,
      showDeleted: false,
    });
    expect(loadFilesView(page).width).toBe(280);
    saveFilesView(page, {
      tabs: [],
      active: null,
      expanded: {},
      width: 444,
      showDeleted: false,
    });
    expect(loadView(page).width).toBe(333);
    expect(loadView(page).tabs).toHaveLength(1);
  });

  it("drops anything unreadable, including tabs of a Files kind", () => {
    localStorage.setItem("harness.structured.session.s1", "{not json");
    expect(loadView(page).tabs).toEqual([]);
    localStorage.setItem(
      "harness.structured.session.s1",
      JSON.stringify({
        tabs: [
          { kind: "schema", root: "session", key: "ok", transient: false },
          { kind: "file", root: "session", key: "a.md", transient: false },
          { kind: "data", root: "elsewhere", key: "x", transient: false },
        ],
        active: "data|session|gone",
        width: 9999,
      }),
    );
    const view = loadView(page);
    expect(view.tabs.map((t) => t.key)).toEqual(["ok"]);
    expect(view.active).toBeNull();
    expect(view.width).toBe(520);
  });
});
