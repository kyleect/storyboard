import type { SkillOwner } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for skills:
 *
 *   ["skills", "list", { scope, id }, { showDeleted }]
 *   ["skills", "detail", id]
 *
 * A skill is fetched by id alone, so details are not under an owner.
 */
export const skillKeys = {
  all: ["skills"] as const,
  lists: () => [...skillKeys.all, "list"] as const,
  list: (owner: SkillOwner, showDeleted: boolean) =>
    [...skillKeys.lists(), scopeKey(owner), { showDeleted }] as const,
  details: () => [...skillKeys.all, "detail"] as const,
  detail: (id: string) => [...skillKeys.details(), id] as const,
};
