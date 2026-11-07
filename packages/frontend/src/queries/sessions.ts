/*
 * Query keys for sessions, from the most generic to the most specific:
 *
 *   ["sessions", "list", { projectId }]
 *   ["sessions", "detail", id]
 *   ["sessions", "debug", id]
 *   ["sessions", "agents", id]
 *
 * Invalidate `lists()` for every session list, `details()` for every open
 * session, or `detail(id)` for one.
 */
export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  /** The sessions of a project, or those outside any project (`null`). */
  list: (projectId: string | null) =>
    [...sessionKeys.lists(), { projectId }] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  detail: (id: string) => [...sessionKeys.details(), id] as const,
  debug: (id: string) => [...sessionKeys.all, "debug", id] as const,
  /** Every session's list of agents it can pick. */
  pickableAgents: () => [...sessionKeys.all, "agents"] as const,
  pickableAgentsFor: (id: string) =>
    [...sessionKeys.pickableAgents(), id] as const,
};

/** Trashed sessions and projects. */
export const trashKeys = {
  all: ["trash"] as const,
};
