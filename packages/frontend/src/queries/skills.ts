import type { SkillOwner } from "../api";
import { scopeKey } from "./scope";

export const skillKeys = {
  all: ["skills"] as const,
  lists: () => [...skillKeys.all, "list"] as const,
  list: (owner: SkillOwner, showDeleted: boolean) =>
    [...skillKeys.lists(), scopeKey(owner), { showDeleted }] as const,
  details: () => [...skillKeys.all, "detail"] as const,
  detail: (id: string) => [...skillKeys.details(), id] as const,
  trees: () => [...skillKeys.all, "tree"] as const,
  treeOf: (owner: SkillOwner, part: "builtin" | "own") =>
    [...skillKeys.trees(), scopeKey(owner), part] as const,
  tree: (owner: SkillOwner, part: "builtin" | "own", showDeleted: boolean) =>
    [...skillKeys.treeOf(owner, part), { showDeleted }] as const,
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
