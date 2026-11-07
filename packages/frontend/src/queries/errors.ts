import type { ErrorFilter } from "../api";

/*
 * Query keys for errors. Invalidate `all` to refresh every console, or
 * `list({ sessionId })` for one session's.
 *
 *   ["errors", "list", filter]
 *   ["errors", "filters"]
 */
export const errorKeys = {
  all: ["errors"] as const,
  lists: () => [...errorKeys.all, "list"] as const,
  list: (filter: ErrorFilter = {}) => [...errorKeys.lists(), filter] as const,
  /** The values the console's filters can take. */
  filters: () => [...errorKeys.all, "filters"] as const,
};
