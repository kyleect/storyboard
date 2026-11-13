import type { FileScope } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for files. Unlike the other features these
 * start with the scope, because a change (or a live event) refreshes
 * everything in one scope, and a file is always fetched within a scope:
 *
 *   ["files", { scope, id }]                         one scope
 *   ["files", { scope, id }, "list", { showDeleted }]
 *   ["files", { scope, id }, "detail", key]
 */
export const fileKeys = {
  all: ["files"] as const,
  inScope: (scope: FileScope) => [...fileKeys.all, scopeKey(scope)] as const,
  lists: (scope: FileScope) => [...fileKeys.inScope(scope), "list"] as const,
  list: (scope: FileScope, showDeleted: boolean) =>
    [...fileKeys.lists(scope), { showDeleted }] as const,
  folders: (scope: FileScope) =>
    [...fileKeys.inScope(scope), "folders"] as const,
  details: (scope: FileScope) =>
    [...fileKeys.inScope(scope), "detail"] as const,
  detail: (scope: FileScope, key: string) =>
    [...fileKeys.details(scope), key] as const,
};
