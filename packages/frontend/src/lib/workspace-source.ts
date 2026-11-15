import type { MediaType } from "@harness/core";
import {
  api,
  workspaceBlob,
  type FileDetail,
  type StoredFile,
  type Workspace,
  type WorkspaceFiles,
} from "../api";
import { workspaceKeys } from "../queries";
import type { ExplorerRoot, ExplorerSource } from "./explorer-source";

export const WORKSPACE_ROOT = "ws:";
export const WORKSPACE_GROUP = "wsg:";
export const WORKSPACES_NODE = "workspaces";

export const workspaceRootId = (id: string): string => `${WORKSPACE_ROOT}${id}`;
export const workspaceIdOf = (root: string): string | null =>
  root.startsWith(WORKSPACE_ROOT) ? root.slice(WORKSPACE_ROOT.length) : null;
export const groupRootId = (scope: string): string =>
  `${WORKSPACE_GROUP}${scope}`;

export const isWorkspaceRoot = (v: unknown): boolean =>
  typeof v === "string" &&
  (v === WORKSPACES_NODE ||
    v.startsWith(WORKSPACE_ROOT) ||
    v.startsWith(WORKSPACE_GROUP));

export const READ_ONLY_HERE =
  "The files of a workspace are changed by agents, or outside the app. Here they can be read.";

const unchangeable = (): Promise<never> =>
  Promise.reject(new Error(READ_ONLY_HERE));

/**
 * The folders and files of one workspace for the Files tree. One request lists
 * the whole workspace; the files and the folders are read from it, so the two
 * lists asked for at once are one request.
 */
export function workspaceSource(workspace: Workspace): ExplorerSource {
  const id = workspace.id;
  let pending: Promise<WorkspaceFiles> | null = null;
  const listing = (): Promise<WorkspaceFiles> => {
    if (workspace.deleted) {
      return Promise.resolve({
        entries: [],
        truncated: false,
        unavailable: false,
      });
    }

    pending ??= api.listWorkspaceFiles(id).finally(() => {
      pending = null;
    });

    return pending;
  };

  return {
    keys: {
      all: workspaceKeys.contents(id),
      list: () => workspaceKeys.listing(id),
      folders: () => workspaceKeys.folders(id),
      detail: (key) => workspaceKeys.detail(id, key),
    },
    list: async (): Promise<StoredFile[]> =>
      (await listing()).entries.flatMap((e) =>
        e.kind === "file"
          ? [
              {
                key: e.path,
                ...(e.mediaType ? { mediaType: e.mediaType as MediaType } : {}),
                value: "",
                updatedAt: e.modifiedAt ?? "",
                deleted: false,
              },
            ]
          : [],
      ),
    listFolders: async () =>
      (await listing()).entries.flatMap((e) =>
        e.kind === "folder" ? [e.path] : [],
      ),
    get: async (key): Promise<FileDetail> => {
      const p = await api.previewWorkspaceFile(id, key);
      const base = { key, updatedAt: "", deleted: false, versions: [] };

      if (p.kind === "text") {
        return {
          ...base,
          mediaType: p.mediaType as MediaType,
          value: p.truncated
            ? `${p.text}\n\n… Only the start of this file is shown (${p.size} bytes in all).`
            : p.text,
        };
      }

      if (p.kind === "media") {
        return {
          ...base,
          mediaType: p.mediaType as MediaType,
          value: "",
          blob: workspaceBlob(id, key, p.size),
        };
      }

      return {
        ...base,
        value: `A binary file of ${p.size} bytes. It cannot be shown here.`,
      };
    },
    write: unchangeable,
    remove: unchangeable,
    restore: unchangeable,
    createFolder: unchangeable,
    renameFolder: unchangeable,
    deleteFolder: unchangeable,
    upload: unchangeable,
  };
}

export const workspaceRoot = (
  workspace: Workspace,
  group: string,
): ExplorerRoot => ({
  id: workspaceRootId(workspace.id),
  label: workspace.name,
  source: workspaceSource(workspace),
  readOnly: READ_ONLY_HERE,
  group,
  deleted: workspace.deleted,
});
