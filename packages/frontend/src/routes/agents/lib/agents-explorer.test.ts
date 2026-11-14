import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaInfo } from "@harness/core";
import type { DataItem, SkillWithFiles } from "../../../api";
import { nodeValue, tabId } from "../../../lib/explorer";
import {
  agentPath,
  buildTree,
  clashTags,
  isNewKey,
  loadView,
  openTab,
  parseNodeValue,
  saveView,
  skillPlace,
  splitPath,
  tabAgent,
  tabNode,
  type AgentLoad,
  type AgentRow,
  type TabsState,
} from "./agents-explorer";

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};

const agent = (id: string, name: string, extra: Partial<AgentRow> = {}) =>
  ({
    id,
    name,
    description: "",
    deleted: false,
    builtin: false,
    projectId: null,
    isDefault: false,
    newTools: 0,
    ...extra,
  }) satisfies AgentRow;

const skill = (
  name: string,
  files: string[] = ["SKILL.md"],
  extra: Partial<SkillWithFiles> = {},
): SkillWithFiles =>
  ({
    id: `id-${name}`,
    name,
    description: "",
    scope: "global",
    projectId: null,
    agentId: null,
    version: 1,
    createdAt: "",
    updatedAt: "",
    deleted: false,
    files: files.map((path) => ({ path })),
    ...extra,
  }) as SkillWithFiles;

const schema = (
  id: string,
  name: string,
  scope: SchemaInfo["scope"],
): SchemaInfo => ({
  id,
  name,
  description: "",
  scope,
  version: 1,
  copiedFrom: null,
  deleted: false,
});

const item = (id: string, name: string, schemaId: string): DataItem =>
  ({
    id,
    name,
    description: "",
    scope: "agent",
    schemaId,
    schemaVersion: 1,
    latestVersion: 1,
    outOfDate: false,
    schemaInScope: true,
    deleted: false,
  }) as DataItem;

const EMPTY: AgentLoad = {
  skills: { own: [], inherited: { project: [], global: [], builtin: [] } },
  schemas: { schemas: [], data: [] },
};

const labels = (nodes: readonly { label: string }[] | undefined) =>
  (nodes ?? []).map((n) => n.label);

describe("paths", () => {
  it("joins an agent's id with what is under it, and splits them again", () => {
    const p = agentPath("a1", "own", "pov/refs/a|b.md");
    expect(splitPath(p, 2)).toEqual(["a1", "own", "pov/refs/a|b.md"]);
    expect(splitPath("a1", 1)).toEqual(["a1"]);
  });
  it("reads a skill place from a node", () => {
    const ref = parseNodeValue(
      nodeValue({
        root: "global",
        kind: "file",
        path: agentPath("a1", "project", "pov/SKILL.md"),
      }),
    );
    expect(skillPlace(ref)).toEqual({
      agentId: "a1",
      origin: "project",
      key: "pov/SKILL.md",
    });
  });
});

describe("clashTags", () => {
  it("tags the rows after the first place of a name", () => {
    const tags = clashTags(
      new Map([
        ["pov", ["own", "global", "builtin"]],
        ["solo", ["global"]],
      ]),
    );
    expect(tags.get("pov\u0000global")).toBe("Overridden by Agent");
    expect(tags.get("pov\u0000builtin")).toBe("Overridden by Agent");
    expect(tags.get("pov\u0000own")).toBeUndefined();
    expect(tags.size).toBe(2);
  });
  it("names the origin that wins when the agent has none", () => {
    const tags = clashTags(new Map([["pov", ["project", "global"]]]));
    expect(tags.get("pov\u0000global")).toBe("Overridden by Project");
  });
});

describe("buildTree", () => {
  const roots = [
    {
      id: "builtin",
      label: "Built-in",
      agents: [agent("b1", "Dispatcher", { builtin: true })],
    },
    {
      id: "global",
      label: "Global",
      agents: [agent("a2", "Zed"), agent("a1", "Editor")],
    },
  ] as const;

  it("has a root for each input, with its agents by name", () => {
    const { data } = buildTree(roots, new Map());
    expect(labels(data)).toEqual(["Built-in", "Global"]);
    expect(labels(data[1]?.children)).toEqual(["Editor", "Zed"]);
  });

  it("holds only a Loading row for an agent that has not been read", () => {
    const { data, info } = buildTree(roots, new Map());
    const editor = must(data[1]?.children?.[0]);
    expect(labels(editor.children)).toEqual(["Loading…"]);
    expect(info.get(editor.value)?.agent?.name).toBe("Editor");
  });

  it("holds the Skills and Schemas folders of an agent that has", () => {
    const { data } = buildTree(roots, new Map([["a1", EMPTY]]));
    const editor = must(data[1]?.children?.[0]);
    expect(labels(editor.children)).toEqual(["Skills", "Schemas"]);
  });

  it("lists own skills with their files, then inherited ones by origin", () => {
    const load: AgentLoad = {
      ...EMPTY,
      skills: {
        own: [skill("pov", ["SKILL.md", "refs/a.md", "refs/deep/b.md"])],
        inherited: {
          project: [skill("tone")],
          global: [skill("plot"), skill("pov")],
          builtin: [skill("outline")],
        },
      },
    };
    const { data, info } = buildTree(roots, new Map([["a1", load]]));
    const skills = must(must(data[1]?.children?.[0]).children?.[0]);
    expect(labels(skills.children)).toEqual([
      "pov",
      "Project",
      "Global",
      "Built-in",
    ]);
    const pov = must(skills.children?.[0]);
    expect(labels(pov.children)).toEqual(["refs", "SKILL.md"]);
    expect(labels(must(pov.children?.[0]).children)).toEqual(["deep", "a.md"]);
    expect(
      parseNodeValue(must(must(pov.children?.[0]).children?.[1]).value),
    ).toEqual({
      root: "global",
      kind: "file",
      path: "a1|own|pov/refs/a.md",
    });
    expect(info.get(pov.value)?.inherited).toBeUndefined();
    const global = must(skills.children?.[2]);
    const inheritedPov = must(global.children?.find((c) => c.label === "pov"));
    const i = must(info.get(inheritedPov.value));
    expect(i.inherited).toBe(true);
    expect(i.origin).toBe("global");
    expect(i.clash).toBe("Overridden by Agent");
    expect(info.get(must(global.children?.[0]).value)?.clash).toBeUndefined();
  });

  it("lists own schemas, then inherited by origin, with data under its schema", () => {
    const load: AgentLoad = {
      ...EMPTY,
      schemas: {
        schemas: [
          schema("s1", "Clue", "agent"),
          schema("s2", "Place", "project"),
          schema("s3", "Setting", "global"),
          schema("s4", "Note", "builtin"),
        ],
        data: [
          item("d1", "Case notes", "s1"),
          item("d2", "Harbour", "s3"),
          item("d3", "Lost", "gone"),
        ],
      },
    };
    const { data, info } = buildTree(roots, new Map([["a1", load]]));
    const schemas = must(must(data[1]?.children?.[0]).children?.[1]);
    expect(labels(schemas.children)).toEqual([
      "Clue",
      "Project",
      "Global",
      "Built-in",
      "Unknown schema",
    ]);
    expect(labels(schemas.children?.[0]?.children)).toEqual(["Case notes"]);
    const global = must(schemas.children?.[2]);
    expect(labels(must(global.children?.[0]).children)).toEqual(["Harbour"]);
    const place = info.get(
      must(must(schemas.children?.[1]).children?.[0]).value,
    );
    expect(place).toMatchObject({ inherited: true, origin: "project" });
    expect(info.get(must(schemas.children?.[0]).value)?.inherited).toBe(
      undefined,
    );
  });

  it("gives every node a value no other has", () => {
    const load: AgentLoad = {
      ...EMPTY,
      skills: {
        own: [skill("pov")],
        inherited: { project: [], global: [skill("pov")], builtin: [] },
      },
      schemas: { schemas: [schema("s1", "Clue", "agent")], data: [] },
    };
    const { data } = buildTree(roots, new Map([["a1", load]]));
    const values: string[] = [];
    const walk = (ns: readonly { value: string; children?: never }[]) => {
      for (const n of ns) {
        values.push(n.value);
        walk((n as { children?: never[] }).children ?? []);
      }
    };
    walk(data as never);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("tabs", () => {
  it("knows a tab for something not yet made", () => {
    expect(isNewKey("new:1")).toBe(true);
    expect(isNewKey("a1|new:2")).toBe(true);
    expect(isNewKey("a1")).toBe(false);
    expect(isNewKey("a1|s1")).toBe(false);
  });

  it("points at the node of a tab and names its agent", () => {
    const t = {
      kind: "skill",
      root: "global",
      key: "a1|own|pov/SKILL.md",
      transient: false,
    } as const;
    expect(tabNode(t)).toBe("global|file|a1|own|pov/SKILL.md");
    expect(tabAgent(t)).toBe("a1");
    expect(tabNode({ ...t, kind: "agent", key: "a1" })).toBe("global|agent|a1");
  });

  it("opens a click as a replaceable tab", () => {
    const empty: TabsState = { tabs: [], active: null };
    const a = openTab(
      empty,
      { kind: "agent", root: "global", key: "a1" },
      false,
    );
    const b = openTab(a, { kind: "agent", root: "global", key: "a2" }, false);
    expect(b.tabs.map(tabId)).toEqual(["agent|global|a2"]);
  });
});

describe("what is remembered", () => {
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

  it("round-trips tabs and folds per page", () => {
    const tabs = [
      { kind: "agent", root: "global", key: "a1", transient: false },
      {
        kind: "skill",
        root: "project",
        key: "a2|own|x/SKILL.md",
        transient: true,
      },
    ] as const;
    saveView("global", {
      tabs: [...tabs],
      active: tabId(tabs[0]),
      expanded: { "global|agent|a1": true },
      width: 300,
      showDeleted: true,
    });
    expect(loadView("global").tabs).toEqual(tabs);
    expect(loadView("global").expanded).toEqual({ "global|agent|a1": true });
    expect(loadView("project-p1").tabs).toEqual([]);
  });

  it("drops tabs of a kind or root it does not know", () => {
    localStorage.setItem(
      "harness.agents.global",
      JSON.stringify({
        tabs: [
          { kind: "agent", root: "session", key: "a", transient: false },
          { kind: "files", root: "global", key: "a", transient: false },
          { kind: "agent", root: "builtin", key: "b", transient: false },
        ],
      }),
    );
    expect(loadView("global").tabs.map(tabId)).toEqual(["agent|builtin|b"]);
  });
});
