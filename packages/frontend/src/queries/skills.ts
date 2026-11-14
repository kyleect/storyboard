import type { SkillOwner } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for skills:
 *
 *   ["skills", "list", { scope, id }, { showDeleted }]
 *   ["skills", "detail", id]
 *   ["skills", "tree", { scope, id }, part, { showDeleted }]
 *   ["skills", "tree", { scope, id }, part, "with-files", { showDeleted }]
 *   ["skills", "file", id, seq, path]
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
  /**
   * What a skills explorer root shows. `part` is `builtin` or `own`: the
   * built-in skills and an owner's own come from the same call but are two
   * roots.
   */
  trees: () => [...skillKeys.all, "tree"] as const,
  treeOf: (owner: SkillOwner, part: "builtin" | "own") =>
    [...skillKeys.trees(), scopeKey(owner), part] as const,
  tree: (owner: SkillOwner, part: "builtin" | "own", showDeleted: boolean) =>
    [...skillKeys.treeOf(owner, part), { showDeleted }] as const,
  /**
   * Skills with their files, as the agents explorer reads them. Under
   * `treeOf`, so a change to a root's files refreshes it too.
   */
  withFiles: (
    owner: SkillOwner,
    part: "builtin" | "own",
    showDeleted: boolean,
  ) =>
    [...skillKeys.treeOf(owner, part), "with-files", { showDeleted }] as const,
  file: (id: string, seq: number | "current", path: string) =>
    [...skillKeys.all, "file", id, seq, path] as const,
  fileOf: (owner: SkillOwner, part: "builtin" | "own", key: string) =>
    [...skillKeys.treeOf(owner, part), "file", key] as const,
};
