import type { SchemaInfo } from "@harness/core";
import type { DataItem, SkillWithFiles } from "../../../api";
import {
  loadViewIn,
  nodeValue,
  openTabIn,
  parseNodeValueOf,
  saveViewIn,
  type ExplorerTab,
  type PageKey,
  type RootId,
  type SavedViewOf,
  type TabsOf,
  type TreeNode,
} from "../../../lib/explorer";

/*
 * The logic behind the editor-style Agents view (`routes/AgentsExplorer.tsx`):
 * a tree of roots (Built-in, Global and, on a project's page, Project), each
 * listing its agents. An agent holds a Skills folder and a Schemas folder.
 * The Skills folder has the agent's own skill folders and files, then the
 * skills it inherits, grouped by where they come from; the Schemas folder has
 * the agent's own schemas, then the inherited ones, each schema holding the
 * agent's data made from it. Pure, so it is tested without a DOM.
 */

export type AgentRootId = "builtin" | "global" | "project";

export const isAgentRoot = (v: unknown): v is AgentRootId =>
  v === "builtin" || v === "global" || v === "project";

/** Where something an agent inherits comes from. */
export type Origin = "project" | "global" | "builtin";

/** Narrowest first: the one an agent gets when a name is in several. */
export const ORIGINS: readonly Origin[] = ["project", "global", "builtin"];

export const ORIGIN_LABEL: Record<Origin, string> = {
  project: "Project",
  global: "Global",
  builtin: "Built-in",
};

export type NodeKind =
  | "root"
  | "agent"
  | "loading"
  | "skills"
  | "skillgroup"
  | "skill"
  | "dir"
  | "file"
  | "schemas"
  | "schemagroup"
  | "schema"
  | "unknown"
  | "data";

export interface NodeRef {
  root: RootId;
  kind: NodeKind;
  /** The agent's id, then what is under it, joined by "|" (`agentPath`). */
  path: string;
}

export const agentPath = (agentId: string, ...rest: string[]): string =>
  [agentId, ...rest].join("|");

/** The agent's id and the parts after it, `count` of them at most. */
export function splitPath(path: string, count: number): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < count; i++) {
    const at = path.indexOf("|", from);
    if (at < 0) break;
    parts.push(path.slice(from, at));
    from = at + 1;
  }
  parts.push(path.slice(from));
  return parts;
}

export const refValue = (r: NodeRef): string => nodeValue(r);

export function parseNodeValue(value: string): NodeRef {
  const r = parseNodeValueOf(value);
  return { root: r.root, kind: r.kind as NodeKind, path: r.path };
}

/** Which skill folder a skill file or folder is under, and where. */
export interface SkillPlace {
  agentId: string;
  /** "own" for the agent's own, else where it is inherited from. */
  origin: "own" | Origin;
  /** `skill` or `skill/path/inside`. */
  key: string;
}

export function skillPlace(ref: NodeRef): SkillPlace {
  const [agentId = "", origin = "own", key = ""] = splitPath(ref.path, 2);
  return { agentId, origin: origin as SkillPlace["origin"], key };
}

/** What a row needs besides its place in the tree. */
export interface NodeInfo {
  name: string;
  deleted: boolean;
  /** Skill and schema rows from somewhere above the agent. */
  inherited?: boolean;
  /** Where an inherited row comes from. */
  origin?: Origin;
  /** A name that is in several places: which one the agent gets. */
  clash?: string;
  /** Data rows: pinned to an older version of the schema. */
  outOfDate?: boolean;
  /** An agent row. */
  agent?: AgentRow;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  deleted: boolean;
  builtin: boolean;
  projectId: string | null;
  isDefault: boolean;
  newTools: number;
}

export interface AgentRootInput {
  id: AgentRootId;
  label: string;
  agents: readonly AgentRow[];
}

/** What is read for an agent when its node is first opened. */
export interface AgentLoad {
  skills: {
    own: readonly SkillWithFiles[];
    inherited: Record<Origin, readonly SkillWithFiles[]>;
  };
  schemas: {
    /** The schemas the agent can make data from, with its own. */
    schemas: readonly SchemaInfo[];
    data: readonly DataItem[];
  };
}

const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

/**
 * For each name found in more than one place, the tag the rows that are not
 * used carry: "Overridden by Project". The agent's own comes first, then
 * project, global and built-in. `places` lists each name's places, narrowest
 * first; the rows after the first are the ones overridden.
 */
export function clashTags(
  places: ReadonlyMap<string, readonly (Origin | "own")[]>,
): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [name, where] of places) {
    const first = where[0];
    if (first === undefined || where.length < 2) continue;
    const label = first === "own" ? "Agent" : ORIGIN_LABEL[first];
    for (const origin of where.slice(1)) {
      tags.set(`${name}\u0000${origin}`, `Overridden by ${label}`);
    }
  }
  return tags;
}

function placesOf(
  own: readonly string[],
  inherited: Record<Origin, readonly string[]>,
): Map<string, ("own" | Origin)[]> {
  const places = new Map<string, ("own" | Origin)[]>();
  const add = (name: string, where: "own" | Origin) =>
    places.set(name, [...(places.get(name) ?? []), where]);
  for (const n of own) add(n, "own");
  for (const o of ORIGINS) for (const n of inherited[o]) add(n, o);
  return places;
}

/** The files of a skill as nested folders and files, by name. */
function skillChildren(
  skill: SkillWithFiles,
  base: (key: string) => { dir: string; file: string },
  info: Map<string, NodeInfo>,
  root: RootId,
  extra: Pick<NodeInfo, "inherited" | "origin">,
): TreeNode[] {
  const top: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  const dirAt = (path: string): TreeNode[] => {
    if (path === "") return top;
    const have = dirs.get(path);
    if (have) return have.children ?? top;
    const at = path.lastIndexOf("/");
    const parent = dirAt(at < 0 ? "" : path.slice(0, at));
    const node: TreeNode = {
      label: at < 0 ? path : path.slice(at + 1),
      value: nodeValue({
        root,
        kind: "dir",
        path: base(`${skill.name}/${path}`).dir,
      }),
      children: [],
    };
    info.set(node.value, {
      name: node.label,
      deleted: skill.deleted,
      ...extra,
    });
    dirs.set(path, node);
    parent.push(node);
    return node.children ?? top;
  };
  for (const f of skill.files) {
    const at = f.path.lastIndexOf("/");
    const into = dirAt(at < 0 ? "" : f.path.slice(0, at));
    const node: TreeNode = {
      label: at < 0 ? f.path : f.path.slice(at + 1),
      value: nodeValue({
        root,
        kind: "file",
        path: base(`${skill.name}/${f.path}`).file,
      }),
    };
    info.set(node.value, {
      name: node.label,
      deleted: skill.deleted,
      ...extra,
    });
    into.push(node);
  }
  const sort = (nodes: TreeNode[]) => {
    // Folders first, then files, each by name.
    nodes.sort((a, b) => {
      const da = a.children ? 0 : 1;
      const db = b.children ? 0 : 1;
      return da - db || byName(a, b);
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(top);
  return top;
}

/** The Skills folder of an agent. */
function skillsFolder(
  root: RootId,
  agentId: string,
  load: AgentLoad["skills"],
  info: Map<string, NodeInfo>,
): TreeNode {
  const folder: TreeNode = {
    label: "Skills",
    value: nodeValue({ root, kind: "skills", path: agentId }),
    children: [],
  };
  info.set(folder.value, { name: "Skills", deleted: false });
  const names = (list: readonly SkillWithFiles[]) =>
    list.filter((s) => !s.deleted).map((s) => s.name);
  const tags = clashTags(
    placesOf(names(load.own), {
      project: names(load.inherited.project),
      global: names(load.inherited.global),
      builtin: names(load.inherited.builtin),
    }),
  );

  const row = (skill: SkillWithFiles, origin: "own" | Origin): TreeNode => {
    const inherited = origin !== "own";
    const extra: Pick<NodeInfo, "inherited" | "origin"> = inherited
      ? { inherited: true, origin }
      : {};
    const node: TreeNode = {
      label: skill.name,
      value: nodeValue({
        root,
        kind: "skill",
        path: agentPath(agentId, origin, skill.name),
      }),
      children: skillChildren(
        skill,
        (key) => ({
          dir: agentPath(agentId, origin, key),
          file: agentPath(agentId, origin, key),
        }),
        info,
        root,
        extra,
      ),
    };
    const clash = tags.get(`${skill.name}\u0000${origin}`);
    info.set(node.value, {
      name: skill.name,
      deleted: skill.deleted,
      ...extra,
      ...(clash && !skill.deleted ? { clash } : {}),
    });
    return node;
  };

  const own = load.own.map((s) => row(s, "own")).sort(byName);
  folder.children?.push(...own);
  for (const origin of ORIGINS) {
    const skills = load.inherited[origin];
    if (skills.length === 0) continue;
    const group: TreeNode = {
      label: ORIGIN_LABEL[origin],
      value: nodeValue({
        root,
        kind: "skillgroup",
        path: agentPath(agentId, origin),
      }),
      children: skills.map((s) => row(s, origin)).sort(byName),
    };
    info.set(group.value, { name: group.label, deleted: false, origin });
    folder.children?.push(group);
  }
  return folder;
}

/** The Schemas folder of an agent. */
function schemasFolder(
  root: RootId,
  agentId: string,
  load: AgentLoad["schemas"],
  info: Map<string, NodeInfo>,
): TreeNode {
  const folder: TreeNode = {
    label: "Schemas",
    value: nodeValue({ root, kind: "schemas", path: agentId }),
    children: [],
  };
  info.set(folder.value, { name: "Schemas", deleted: false });

  const originOf = (s: SchemaInfo): "own" | Origin =>
    s.scope === "agent" ? "own" : (s.scope as Origin);
  const live = (s: SchemaInfo) => !s.deleted;
  const names = (o: Origin) =>
    load.schemas.filter((s) => live(s) && originOf(s) === o).map((s) => s.name);
  const tags = clashTags(
    placesOf(
      load.schemas
        .filter((s) => live(s) && originOf(s) === "own")
        .map((s) => s.name),
      {
        project: names("project"),
        global: names("global"),
        builtin: names("builtin"),
      },
    ),
  );

  const known = new Set(load.schemas.map((s) => s.id));
  const nodes = new Map<string, TreeNode>();
  const rowOf = (s: SchemaInfo): TreeNode => {
    const origin = originOf(s);
    const node: TreeNode = {
      label: s.name,
      value: nodeValue({
        root,
        kind: "schema",
        path: agentPath(agentId, s.id),
      }),
      children: [],
    };
    const clash = tags.get(`${s.name}\u0000${origin}`);
    info.set(node.value, {
      name: s.name,
      deleted: s.deleted,
      ...(origin === "own" ? {} : { inherited: true, origin }),
      ...(clash ? { clash } : {}),
    });
    nodes.set(s.id, node);
    return node;
  };
  const dataRow = (d: DataItem): TreeNode => {
    const node: TreeNode = {
      label: d.name,
      value: nodeValue({
        root,
        kind: "data",
        path: agentPath(agentId, d.id),
      }),
    };
    info.set(node.value, {
      name: d.name,
      deleted: d.deleted,
      outOfDate: d.outOfDate,
    });
    return node;
  };

  const own = load.schemas
    .filter((s) => originOf(s) === "own")
    .map(rowOf)
    .sort(byName);
  folder.children?.push(...own);
  for (const origin of ORIGINS) {
    const schemas = load.schemas.filter((s) => originOf(s) === origin);
    if (schemas.length === 0) continue;
    const group: TreeNode = {
      label: ORIGIN_LABEL[origin],
      value: nodeValue({
        root,
        kind: "schemagroup",
        path: agentPath(agentId, origin),
      }),
      children: schemas.map(rowOf).sort(byName),
    };
    info.set(group.value, { name: group.label, deleted: false, origin });
    folder.children?.push(group);
  }

  const orphans: DataItem[] = [];
  for (const d of load.data) {
    const parent = nodes.get(d.schemaId);
    if (parent && known.has(d.schemaId)) parent.children?.push(dataRow(d));
    else orphans.push(d);
  }
  for (const n of nodes.values()) n.children?.sort(byName);
  if (orphans.length > 0) {
    const node: TreeNode = {
      label: "Unknown schema",
      value: nodeValue({ root, kind: "unknown", path: agentId }),
      children: orphans.map(dataRow).sort(byName),
    };
    info.set(node.value, { name: "Unknown schema", deleted: false });
    folder.children?.push(node);
  }
  return folder;
}

/**
 * One tree: a root per input, each with its agents by name. An agent whose
 * skills and schemas have been read holds the two folders; one that has not
 * holds a single "Loading" row, which is what makes it open.
 */
export function buildTree(
  roots: readonly AgentRootInput[],
  loaded: ReadonlyMap<string, AgentLoad>,
): { data: TreeNode[]; info: Map<string, NodeInfo> } {
  const info = new Map<string, NodeInfo>();
  const data = roots.map((r) => {
    const top: TreeNode = {
      label: r.label,
      value: nodeValue({ root: r.id, kind: "root", path: "" }),
      children: [],
    };
    info.set(top.value, { name: r.label, deleted: false });
    const agents = [...r.agents]
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      )
      .map((a): TreeNode => {
        const node: TreeNode = {
          label: a.name,
          value: nodeValue({ root: r.id, kind: "agent", path: a.id }),
          children: [],
        };
        info.set(node.value, { name: a.name, deleted: a.deleted, agent: a });
        const load = loaded.get(a.id);
        if (!load) {
          const wait: TreeNode = {
            label: "Loading…",
            value: nodeValue({ root: r.id, kind: "loading", path: a.id }),
          };
          info.set(wait.value, { name: "Loading…", deleted: false });
          node.children?.push(wait);
        } else {
          node.children?.push(
            skillsFolder(r.id, a.id, load.skills, info),
            schemasFolder(r.id, a.id, load.schemas, info),
          );
        }
        return node;
      });
    top.children?.push(...agents);
    return top;
  });
  return { data, info };
}

// ----------------------------------------------------------------- the tabs

export type TabKind = "agent" | "skill" | "schema" | "data";

/**
 * A tab. `root` is the root of the agent; `key` is the agent's id for an
 * agent (`new:1` for one not yet made), else the agent's id and what is
 * opened, as in a node's path.
 */
export type TabState = ExplorerTab<TabKind>;
export type TabsState = TabsOf<TabState>;

export const isNewKey = (key: string): boolean =>
  key.startsWith("new:") || key.includes("|new:");

export const openTab = (
  state: TabsState,
  tab: Omit<TabState, "transient">,
  permanent: boolean,
): TabsState => openTabIn(state, tab, permanent, () => true);

const NODE_KIND: Record<TabKind, NodeKind> = {
  agent: "agent",
  skill: "file",
  schema: "schema",
  data: "data",
};

/** The tree node a tab stands for. */
export const tabNode = (t: TabState): string =>
  nodeValue({ root: t.root, kind: NODE_KIND[t.kind], path: t.key });

/** The agent a tab is about. */
export const tabAgent = (t: Pick<TabState, "key">): string =>
  splitPath(t.key, 1)[0] ?? "";

// -------------------------------------------------- remembered between visits

export type SavedView = SavedViewOf<TabState>;

const KINDS = ["agent", "skill", "schema", "data"] as const;

/** `page`: "global", or `project-<id>`. */
export const loadView = (page: PageKey): SavedView =>
  loadViewIn("agents", page, KINDS, isAgentRoot);

export const saveView = (page: PageKey, view: SavedView): void =>
  saveViewIn("agents", page, view);
