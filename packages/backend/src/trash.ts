import type { Store } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purges what has been in the trash for more than `days` days. 0 turns
 * automatic purging off. Run at startup only (design Q3e). Returns the ids
 * of the purged sessions.
 */
export function purgeExpiredTrash(
  store: Store,
  days: number,
  now: Date = new Date(),
): string[] {
  if (days === 0) return [];
  const before = new Date(now.getTime() - days * DAY_MS).toISOString();
  return store.purgeTrashedSessions(before);
}
