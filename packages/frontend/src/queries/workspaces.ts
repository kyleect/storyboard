import type { WorkspaceOwner } from "../api";

/*
 * Query keys for workspaces:
 *
 *   ["workspaces", "list", { showDeleted }]
 *   ["workspaces", "attached", owner, id]   what a project or session has
 *   ["workspaces", "grants"]                "Always allow" per tool
 *   ["workspaces", "dirs", path]            the folder picker
 *   ["workspaces", "tree", id, path]        one folder of a workspace's tree
 *   ["workspaces", "index", id]             its ticks and index status
 *   ["workspaces", "file", sessionId, ref]  a media file shown in the chat
 */
export const workspaceKeys = {
  all: ["workspaces"] as const,
  lists: () => [...workspaceKeys.all, "list"] as const,
  list: (showDeleted: boolean) =>
    [...workspaceKeys.lists(), { showDeleted }] as const,
  attachedAll: () => [...workspaceKeys.all, "attached"] as const,
  attached: (owner: WorkspaceOwner, id: string) =>
    [...workspaceKeys.attachedAll(), owner, id] as const,
  grants: () => [...workspaceKeys.all, "grants"] as const,
  file: (sessionId: string, ref: string) =>
    [...workspaceKeys.all, "file", sessionId, ref] as const,
  trees: (id: string) => [...workspaceKeys.all, "tree", id] as const,
  tree: (id: string, path: string) =>
    [...workspaceKeys.trees(id), path] as const,
  index: (id: string) => [...workspaceKeys.all, "index", id] as const,
  dirs: (path: string) => [...workspaceKeys.all, "dirs", path] as const,
};
