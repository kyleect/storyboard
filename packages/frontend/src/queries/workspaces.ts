import type { FileScope } from "../api";

export const workspaceKeys = {
  all: ["workspaces"] as const,
  lists: () => [...workspaceKeys.all, "list"] as const,
  list: (scope: FileScope, showDeleted: boolean) =>
    [...workspaceKeys.lists(), scope, { showDeleted }] as const,
  one: (id: string) => [...workspaceKeys.all, "one", id] as const,
  /** What the Files tree shows of one workspace: its listing and its files. */
  contents: (id: string) => [...workspaceKeys.all, "contents", id] as const,
  listing: (id: string, scope: FileScope) =>
    [...workspaceKeys.contents(id), "listing", scope] as const,
  folders: (id: string, scope: FileScope) =>
    [...workspaceKeys.contents(id), "folders", scope] as const,
  /** What is ignored, and what the scope hides, for the tree's marks. */
  marks: (id: string, scope: FileScope) =>
    [...workspaceKeys.contents(id), "marks", scope] as const,
  detail: (id: string, path: string) =>
    [...workspaceKeys.contents(id), "file", path] as const,
  grants: () => [...workspaceKeys.all, "grants"] as const,
  file: (sessionId: string, ref: string) =>
    [...workspaceKeys.all, "file", sessionId, ref] as const,
  trees: (id: string) => [...workspaceKeys.all, "tree", id] as const,
  tree: (id: string, path: string, scope?: FileScope) =>
    [...workspaceKeys.trees(id), path, scope ?? null] as const,
  index: (id: string) => [...workspaceKeys.all, "index", id] as const,
  dirs: (path: string) => [...workspaceKeys.all, "dirs", path] as const,
};
