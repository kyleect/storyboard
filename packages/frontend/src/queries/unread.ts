import { sessionKeys } from "./sessions";

/*
 * Query keys for which sessions have a reply the user has not seen. The key
 * is part of `sessionKeys.lists()`: whatever changes a session list can
 * change it, so a run ending, or a chat being opened, refreshes it along with
 * the lists and needs no call of its own.
 *
 *   ["sessions", "list", "unread"]
 */
export const unreadKeys = {
  /** The ids of the sessions with a reply not yet seen, in any project. */
  sessions: () => [...sessionKeys.lists(), "unread"] as const,
};
