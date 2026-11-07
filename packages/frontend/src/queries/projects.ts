/*
 * Query keys for projects:
 *
 *   ["projects", "list"]
 *   ["projects", "detail", id]
 */
export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  details: () => [...projectKeys.all, "detail"] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
};
