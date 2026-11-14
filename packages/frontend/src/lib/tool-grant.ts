import { TOOL_GROUPS, type ToolGroup } from "@harness/core";

export type ToolMode = "allow" | "deny";

export interface ToolGrant {
  mode: ToolMode;
  groups: ToolGroup[];
  except: string[];
  extras: string[];
  known: string[];
}

export interface GrantTool {
  name: string;
  group: ToolGroup;
  needsReview: boolean;
  alwaysOn: boolean;
}

export const emptyGrant = (): ToolGrant => ({
  mode: "allow",
  groups: [],
  except: [],
  extras: [],
  known: [],
});

export function groupTools<T extends { group: ToolGroup }>(
  tools: readonly T[],
): { id: ToolGroup; label: string; tools: T[] }[] {
  return TOOL_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    tools: tools.filter((t) => t.group === g.id),
  })).filter((g) => g.tools.length > 0);
}

export const mcpServerOf = (name: string): string | undefined =>
  /^mcp_([a-z0-9][a-z0-9-]*)_/.exec(name)?.[1];

export interface ToolSection<T> {
  id: string;
  group: ToolGroup;
  label: string;
  tools: T[];
  children?: ToolSection<T>[];
}

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

export const hasTool = (g: ToolGrant, t: GrantTool): boolean =>
  t.alwaysOn || covered(g, t);

const without = (list: readonly string[], names: ReadonlySet<string>) =>
  list.filter((n) => !names.has(n));

export function setTool(g: ToolGrant, t: GrantTool, on: boolean): ToolGrant {
  const inGroup = g.groups.includes(t.group);
  const self = new Set([t.name]);
  let except = without(g.except, self);
  let extras = without(g.extras, self);
  if (g.mode === "allow") {
    const byGroup = inGroup && !t.needsReview;
    if (on && !byGroup) extras = [...extras, t.name];
    if (!on && byGroup) except = [...except, t.name];
  } else if (t.needsReview) {
    if (on) except = [...except, t.name];
  } else {
    if (on && inGroup) except = [...except, t.name];
    if (!on && !inGroup) extras = [...extras, t.name];
  }
  return { ...g, except, extras };
}

export function setGroup(
  g: ToolGrant,
  group: ToolGroup,
  tools: readonly GrantTool[],
  on: boolean,
): ToolGrant {
  const names = new Set(tools.map((t) => t.name));
  const review = tools.filter((t) => t.needsReview);
  const keepReview = new Set(
    on ? review.filter((t) => covered(g, t)).map((t) => t.name) : [],
  );
  const groups = g.groups.filter((x) => x !== group);
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

export const forget = (g: ToolGrant, name: string): ToolGrant => ({
  ...g,
  except: g.except.filter((n) => n !== name),
  extras: g.extras.filter((n) => n !== name),
});

export type GroupApproval = "own" | "ask" | "skip" | "mixed";

interface ApprovalTool {
  name: string;
  fixed: boolean;
}

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

export function switchMode(
  g: ToolGrant,
  mode: ToolMode,
  tools: readonly GrantTool[],
): ToolGrant {
  if (g.mode === mode) return g;
  const have = new Set(tools.filter((t) => covered(g, t)).map((t) => t.name));
  const usual = tools.filter((t) => !t.alwaysOn);
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
    except: usual
      .filter((t) => t.needsReview && have.has(t.name))
      .map((t) => t.name),
    extras: usual
      .filter((t) => !t.needsReview && !have.has(t.name) && !inGroups(t))
      .map((t) => t.name),
  };
}
