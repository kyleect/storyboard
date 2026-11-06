import { z } from "zod";
import { TOOL_GROUPS, type Tool, type ToolGroup } from "@harness/core";

/*
 * An agent's tool grant (tool management design, decisions 1, 5, 6, 9).
 * Instead of a plain list of tool names, an agent holds groups, exceptions
 * and extras, plus the tools that existed when it was last saved.
 *
 * allow mode (the agent has only what it is given):
 *   - `groups`: every tool of a granted group,
 *   - `except`: tools switched off inside a granted group,
 *   - `extras`: single tools granted outside any granted group.
 * deny mode (the agent has everything but what is denied):
 *   - `groups`: every tool of a denied group,
 *   - `except`: tools still allowed inside a denied group, and the tools that
 *     need review that the agent has been given (a blanket grant does not
 *     cover those, as in allow mode),
 *   - `extras`: single tools denied outside any denied group.
 * `known` is the set of tools that existed when the version was saved. A tool
 * that is not in it is new to the agent.
 */

export const ToolMode = z.enum(["allow", "deny"]);
export type ToolMode = z.infer<typeof ToolMode>;

const GROUP_IDS = TOOL_GROUPS.map((g) => g.id) as [ToolGroup, ...ToolGroup[]];

export const ToolGrant = z.object({
  mode: ToolMode,
  groups: z.array(z.enum(GROUP_IDS)),
  except: z.array(z.string()),
  extras: z.array(z.string()),
  known: z.array(z.string()),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

/** The tool facts a grant is worked out from. */
export type GrantTool = Pick<Tool, "name" | "group" | "needsReview">;

/** An allow grant with nothing in it. */
export const emptyGrant = (): ToolGrant => ({
  mode: "allow",
  groups: [],
  except: [],
  extras: [],
  known: [],
});

/** Removes repeated entries. */
export function normalizeGrant(g: ToolGrant): ToolGrant {
  return {
    mode: g.mode,
    groups: [...new Set(g.groups)],
    except: [...new Set(g.except)],
    extras: [...new Set(g.extras)],
    known: [...new Set(g.known)],
  };
}

/**
 * The names of the tools the grant allows. A tool that needs review is not
 * covered by a blanket grant: in allow mode it has to be listed in `extras`,
 * in deny mode in `except` (decision 11, P5, and the answer to the plan's
 * open question: deny mode keeps such tools off until they are given).
 */
export function allowedNames(
  grant: ToolGrant,
  tools: readonly GrantTool[],
): string[] {
  const groups = new Set<string>(grant.groups);
  const except = new Set(grant.except);
  const extras = new Set(grant.extras);
  if (grant.mode === "allow") {
    return tools
      .filter(
        (t) =>
          extras.has(t.name) ||
          (groups.has(t.group) && !except.has(t.name) && !t.needsReview),
      )
      .map((t) => t.name);
  }
  return tools
    .filter((t) => {
      if (extras.has(t.name)) return false;
      if (t.needsReview) return except.has(t.name);
      return !(groups.has(t.group) && !except.has(t.name));
    })
    .map((t) => t.name);
}

/**
 * The grant as a plain list, the way `agents_list` and an export show it:
 * the allowed tools for an allow agent, the denied tools for a deny agent.
 */
export function listedTools(
  grant: ToolGrant,
  tools: readonly GrantTool[],
): { toolMode: ToolMode; tools: string[] } {
  const allowed = new Set(allowedNames(grant, tools));
  return {
    toolMode: grant.mode,
    tools: tools
      .filter((t) => (grant.mode === "allow") === allowed.has(t.name))
      .map((t) => t.name),
  };
}

/**
 * The tools that exist now but were not there when the agent was last saved
 * (decision 9). A deny agent has them on already, except those that need
 * review, which it has to be given.
 */
export function newToolNames(
  grant: ToolGrant,
  tools: readonly GrantTool[],
): string[] {
  const known = new Set(grant.known);
  return tools
    .filter(
      (t) => !known.has(t.name) && (grant.mode === "allow" || t.needsReview),
    )
    .map((t) => t.name);
}

/**
 * A grant made of single tools only, for an import (decision 17): it never
 * grants a group, so a file cannot give an agent more than it names.
 */
export function grantFromNames(
  mode: ToolMode,
  names: readonly string[],
  tools: readonly GrantTool[],
): ToolGrant {
  const listed = new Set(names);
  return normalizeGrant({
    mode,
    groups: [],
    // A deny list names what is denied; a tool that needs review is only on
    // if the file leaves it out of that list.
    except:
      mode === "deny"
        ? tools
            .filter((t) => t.needsReview && !listed.has(t.name))
            .map((t) => t.name)
        : [],
    extras: [...names],
    known: tools.map((t) => t.name),
  });
}
