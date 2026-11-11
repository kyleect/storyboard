/*
 * Query keys for runs. The active runs (every run in progress, in any
 * session) feed the activity indicators; the app-wide stream invalidates them
 * on `runs.changed`.
 *
 *   ["runs", "active"]
 */
export const runKeys = {
  all: ["runs"] as const,
  active: () => [...runKeys.all, "active"] as const,
};
