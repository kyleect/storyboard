import type { EntryKind } from "@harness/core";
import type { EntryScope } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for files and memory notes. Unlike the other features these
 * start with the scope, because a change (or a live event) refreshes
 * everything in one scope, and an entry is always fetched within a scope:
 *
 *   ["entries", { scope, id }]                         one scope
 *   ["entries", { scope, id }, kind]                   its files or notes
 *   ["entries", { scope, id }, kind, "list", { showDeleted }]
 *   ["entries", { scope, id }, kind, "detail", key]
 */
export const entryKeys = {
  all: ["entries"] as const,
  inScope: (scope: EntryScope) => [...entryKeys.all, scopeKey(scope)] as const,
  ofKind: (scope: EntryScope, kind: EntryKind) =>
    [...entryKeys.inScope(scope), kind] as const,
  lists: (scope: EntryScope, kind: EntryKind) =>
    [...entryKeys.ofKind(scope, kind), "list"] as const,
  list: (scope: EntryScope, kind: EntryKind, showDeleted: boolean) =>
    [...entryKeys.lists(scope, kind), { showDeleted }] as const,
  details: (scope: EntryScope, kind: EntryKind) =>
    [...entryKeys.ofKind(scope, kind), "detail"] as const,
  detail: (scope: EntryScope, kind: EntryKind, key: string) =>
    [...entryKeys.details(scope, kind), key] as const,
};
