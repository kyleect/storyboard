import type { Agent, AgentStore } from "./agents-store.js";
import { readSettings } from "./settings.js";
import type { Store } from "./store.js";

/*
 * The agent a new session starts with (global default agent design, section
 * 3): the project's default, if it has a usable one; else the global default;
 * else none. The user's own pick in a session wins afterwards.
 */

export function defaultAgentFor(
  deps: {
    store: Store;
    agents: AgentStore;
    env?: NodeJS.ProcessEnv | undefined;
  },
  projectId: string | null,
): Agent | undefined {
  const usable = (id: string | null | undefined) => {
    const agent = id ? deps.agents.get(id) : undefined;
    return agent && deps.agents.usableIn(agent, projectId) ? agent : undefined;
  };
  const own = projectId
    ? usable(deps.store.getProject(projectId)?.default_agent_id)
    : undefined;
  if (own) return own;
  // Only a global agent can be the global default (design Q4).
  const global = usable(
    readSettings(deps.store.db, deps.env).effective.defaultAgentId,
  );
  return global && global.projectId === null ? global : undefined;
}
