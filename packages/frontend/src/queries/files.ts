import type { FileScope } from "../api";
import { scopeKey } from "./scope";

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
