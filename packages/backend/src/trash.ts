import type { Store } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Purged {
  projects: string[];
  sessions: string[];
  /** The first messages of the deleted branches that were purged. */
  branches: string[];
}

/**
 * Purges what has been in the trash for more than `days` days: projects
 * (with their sessions) counted from when the project was trashed, and
 * sessions trashed on their own. 0 turns automatic purging off. Run at
 * startup only (design Q3e). Deleted branches count from when each was
 * deleted. Returns the ids purged; a project's sessions are not listed
 * separately.
 */
export function purgeExpiredTrash(
  store: Store,
  days: number,
  now: Date = new Date(),
): Purged {
  if (days === 0) return { projects: [], sessions: [], branches: [] };
  const before = new Date(now.getTime() - days * DAY_MS).toISOString();
  return store.db.transaction(() => ({
    projects: store.purgeTrashedProjects(before),
    sessions: store.purgeTrashedSessions(before),
    branches: store.purgeTrashedBranches(before),
  }))();
}
