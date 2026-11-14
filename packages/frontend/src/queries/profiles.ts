/*
 * Query keys for profiles:
 *
 *   ["profiles", "list"]   the profiles, the trashed ones and the active id
 *
 * A switch resets every query (the whole cache belongs to the old profile),
 * so no other feature's keys carry the profile.
 */
export const profileKeys = {
  all: ["profiles"] as const,
  list: () => [...profileKeys.all, "list"] as const,
};
