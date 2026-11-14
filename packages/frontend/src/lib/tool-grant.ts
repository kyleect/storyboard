import { TOOL_GROUPS, type ToolGroup } from "@harness/core";

/*
 * The agent editor's tool grant (tool management design, decisions 2, 5, 6,
 * 8): groups, exceptions and extras, worked out the way the backend does
 * (`allowedNames`), and the changes a click makes to them. All pure, so they
 * can be tested without a screen.
 */

export type ToolMode = "allow" | "deny";

/** What an agent stores. `known` is set by the backend on every save. */
export interface ToolGrant {
  mode: ToolMode;
  groups: ToolGroup[];
  except: string[];
  extras: string[];
  known: string[];
}

/** The facts about a tool that the grant is worked out from. */
export interface GrantTool {
  name: string;
  group: ToolGroup;
  needsReview: boolean;
  /** Offered to every agent (shown locked). */
  alwaysOn: boolean;
}

export const emptyGrant = (): ToolGrant => ({
  mode: "allow",
  groups: [],
  except: [],
  extras: [],
  known: [],
});

/** The tools in each group, in the order groups are shown; empty groups left out. */
export function groupTools<T extends { group: ToolGroup }>(
  tools: readonly T[],
): { id: ToolGroup; label: string; tools: T[] }[] {
  return TOOL_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    tools: tools.filter((t) => t.group === g.id),
  })).filter((g) => g.tools.length > 0);
}

/**
 * The server an MCP tool belongs to, from its name `mcp_<server>_<tool>`. A
 * server name has no "_" (backend `SERVER_NAME`), so the first "_" after the
 * prefix ends it.
 */
export const mcpServerOf = (name: string): string | undefined =>
  /^mcp_([a-z0-9][a-z0-9-]*)_/.exec(name)?.[1];

/** A box in the agent editor: a tool group, or one MCP server's tools. */
export interface ToolSection<T> {
  /** Unique among the sections; an MCP server's is `mcp:<server>`. */
  id: string;
  /** The group the tools are in. */
  group: ToolGroup;
  label: string;
  tools: T[];
  /** Sections inside this one: the MCP group has one per server. */
  children?: ToolSection<T>[];
}

/**
 * `groupTools`, with each MCP server's tools also in a section of its own
 * inside the MCP group (named as the server is, in the order of the server
 * names). An MCP tool whose name does not give a server goes in one named
 * "Other".
 */
export function sectionTools<T extends { name: string; group: ToolGroup }>(
  tools: readonly T[],
): ToolSection<T>[] {
  return groupTools(tools).map((g): ToolSection<T> => {
    if (g.id !== "mcp") return { ...g, group: g.id };
    const servers = new Map<string, T[]>();
    for (const t of g.tools) {
      const server = mcpServerOf(t.name) ?? "";
      servers.set(server, [...(servers.get(server) ?? []), t]);
    }
    return {
      ...g,
      group: g.id,
      children: [...servers]
        .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
        .map(([server, inServer]) => ({
          id: `mcp:${server}`,
          group: g.id,
          label: server === "" ? "Other" : server,
          tools: inServer,
        })),
    };
  });
}

/**
 * Whether the grant itself covers the tool (the same rules as the backend).
 * A tool that needs review is never covered by a blanket grant: in allow
 * mode it has to be in `extras`, in deny mode in `except`.
 */
function covered(g: ToolGrant, t: GrantTool): boolean {
  const inGroup = g.groups.includes(t.group);
  if (g.mode === "allow") {
    return (
      g.extras.includes(t.name) ||
      (inGroup && !g.except.includes(t.name) && !t.needsReview)
    );
  }
  if (g.extras.includes(t.name)) return false;
  if (t.needsReview) return g.except.includes(t.name);
  return !(inGroup && !g.except.includes(t.name));
}

/** Whether the agent has the tool: always-on tools are on whatever the grant says. */
export const hasTool = (g: ToolGrant, t: GrantTool): boolean =>
  t.alwaysOn || covered(g, t);

const without = (list: readonly string[], names: ReadonlySet<string>) =>
  list.filter((n) => !names.has(n));

/** Switches one tool on or off, keeping the grant as small as it can be. */
export function setTool(g: ToolGrant, t: GrantTool, on: boolean): ToolGrant {
  const inGroup = g.groups.includes(t.group);
  const self = new Set([t.name]);
  let except = without(g.except, self);
  let extras = without(g.extras, self);
  if (g.mode === "allow") {
    // A tool that needs review is never covered by its group: it has to be
    // listed on its own (design, decision 11).
    const byGroup = inGroup && !t.needsReview;
    if (on && !byGroup) extras = [...extras, t.name];
    if (!on && byGroup) except = [...except, t.name];
  } else if (t.needsReview) {
    // Off unless it is given, whatever the groups say.
    if (on) except = [...except, t.name];
  } else {
    // In deny mode "on" means not denied.
    if (on && inGroup) except = [...except, t.name];
    if (!on && !inGroup) extras = [...extras, t.name];
  }
  return { ...g, except, extras };
}

/**
 * Switches a whole group on or off. `tools` are the group's tools. In allow
 * mode, switching a group on leaves a tool that needs review as it was.
 */
export function setGroup(
  g: ToolGrant,
  group: ToolGroup,
  tools: readonly GrantTool[],
  on: boolean,
): ToolGrant {
  const names = new Set(tools.map((t) => t.name));
  // Switching a group on leaves a tool that needs review as it was; it has
  // to be given on its own.
  const review = tools.filter((t) => t.needsReview);
  const keepReview = new Set(
    on ? review.filter((t) => covered(g, t)).map((t) => t.name) : [],
  );
  const groups = g.groups.filter((x) => x !== group);
  // Allow: on grants the group. Deny: off denies it.
  const listed = g.mode === "allow" ? on : !on;
  const keptExtras = g.mode === "allow" ? keepReview : new Set<string>();
  const keptExcept = g.mode === "deny" ? keepReview : new Set<string>();
  return {
    ...g,
    groups: listed ? [...groups, group] : groups,
    except: g.except.filter((n) => !names.has(n) || keptExcept.has(n)),
    extras: g.extras.filter((n) => !names.has(n) || keptExtras.has(n)),
  };
}

/**
 * Switches some of a group's tools on or off, for a section that is only part
 * of a group (one MCP server's tools): `setGroup` would grant or deny the
 * whole group. As with `setGroup`, switching on leaves a tool that needs
 * review as it was.
 */
export function setTools(
  g: ToolGrant,
  tools: readonly GrantTool[],
  on: boolean,
): ToolGrant {
  return tools
    .filter((t) => !on || !t.needsReview)
    .reduce((acc, t) => setTool(acc, t, on), g);
}

export type ToggleState = "all" | "none" | "mixed";

/** How many of a group's tools the agent has. */
export function groupCount(
  g: ToolGrant,
  tools: readonly GrantTool[],
): { on: number; total: number } {
  return { on: tools.filter((t) => hasTool(g, t)).length, total: tools.length };
}

export function toggleState(
  g: ToolGrant,
  tools: readonly GrantTool[],
): ToggleState {
  const { on, total } = groupCount(g, tools);
  return on === total ? "all" : on === 0 ? "none" : "mixed";
}

/** Removes a name from the exceptions and extras (a tool that is gone). */
export const forget = (g: ToolGrant, name: string): ToolGrant => ({
  ...g,
  except: g.except.filter((n) => n !== name),
  extras: g.extras.filter((n) => n !== name),
});

/* ---- Approval, per group (design decision 2) ---- */

export type GroupApproval = "own" | "ask" | "skip" | "mixed";

interface ApprovalTool {
  name: string;
  /** A tool that always asks has no setting of the agent's. */
  fixed: boolean;
}

/** What the agent's approval choices say across a group's tools. */
export function groupApproval(
  approval: Readonly<Record<string, boolean>>,
  tools: readonly ApprovalTool[],
): GroupApproval {
  const values = tools.filter((t) => !t.fixed).map((t) => approval[t.name]);
  if (values.every((v) => v === undefined)) return "own";
  if (values.every((v) => v === true)) return "ask";
  if (values.every((v) => v === false)) return "skip";
  return "mixed";
}

/** Sets the choice for every tool of a group that can have one. */
export function setGroupApproval(
  approval: Readonly<Record<string, boolean>>,
  tools: readonly ApprovalTool[],
  value: Exclude<GroupApproval, "mixed">,
): Record<string, boolean> {
  const names = new Set(tools.filter((t) => !t.fixed).map((t) => t.name));
  const rest = Object.fromEntries(
    Object.entries(approval).filter(([n]) => !names.has(n)),
  );
  if (value === "own") return rest;
  return {
    ...rest,
    ...Object.fromEntries([...names].map((n) => [n, value === "ask"])),
  };
}

/**
 * Changes between an allow list and a deny list without changing which tools
 * the agent has: the tools it has now are written again in the other form,
 * as whole groups where it can and single tools where it cannot. Tools that
 * are always on are left out, as the backend does.
 */
export function switchMode(
  g: ToolGrant,
  mode: ToolMode,
  tools: readonly GrantTool[],
): ToolGrant {
  if (g.mode === mode) return g;
  const have = new Set(tools.filter((t) => covered(g, t)).map((t) => t.name));
  const usual = tools.filter((t) => !t.alwaysOn);
  // A group is granted (allow) or denied (deny) when it covers every tool of
  // it that does not need review; the others are listed on their own.
  const groups: ToolGroup[] = [];
  for (const { id, tools: inGroup } of groupTools(usual)) {
    const plain = inGroup.filter((t) => !t.needsReview);
    const want = (t: GrantTool) => have.has(t.name) === (mode === "allow");
    if (plain.length > 0 && plain.every(want)) groups.push(id);
  }
  const inGroups = (t: GrantTool) => groups.includes(t.group);
  if (mode === "allow") {
    return {
      ...g,
      mode,
      groups,
      except: [],
      extras: usual
        .filter((t) => have.has(t.name) && (t.needsReview || !inGroups(t)))
        .map((t) => t.name),
    };
  }
  return {
    ...g,
    mode,
    groups,
    // Tools that need review and are given.
    except: usual
      .filter((t) => t.needsReview && have.has(t.name))
      .map((t) => t.name),
    extras: usual
      .filter((t) => !t.needsReview && !have.has(t.name) && !inGroups(t))
      .map((t) => t.name),
  };
}
