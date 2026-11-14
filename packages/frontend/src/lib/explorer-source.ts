import type { MediaType } from "@harness/core";
import {
  api,
  type FileDetail,
  type FileScope,
  type StoredFile,
  type UploadedFile,
} from "../api";
import { fileKeys } from "../queries";
import type { RootId } from "./explorer";

export interface ExplorerSource {
  keys: {
    all: readonly unknown[];
    list: (showDeleted: boolean) => readonly unknown[];
    folders: () => readonly unknown[];
    detail: (key: string) => readonly unknown[];
  };
  list: (showDeleted: boolean) => Promise<StoredFile[]>;
  listFolders: () => Promise<string[]>;
  get: (key: string) => Promise<FileDetail>;
  write: (
    key: string,
    mediaType: MediaType,
    text: string,
  ) => Promise<FileDetail>;
  remove: (key: string) => Promise<unknown>;
  restore: (key: string, seq: number) => Promise<unknown>;
  createFolder: (path: string) => Promise<unknown>;
  renameFolder: (path: string, to: string) => Promise<unknown>;
  deleteFolder: (path: string) => Promise<unknown>;
  accepts?: { anyType: true };
  upload: (
    file: File,
    mediaType: string,
    name: string,
  ) => Promise<Pick<UploadedFile, "key">>;
}

export interface ExplorerRoot {
  id: RootId;
  label: string;
  source: ExplorerSource;
  readOnly?: string | undefined;
  broadNote?: string | undefined;
  projectId?: string | undefined;
}

export function filesSource(scope: FileScope): ExplorerSource {
  return {
    keys: {
      all: fileKeys.inScope(scope),
      list: (showDeleted) => fileKeys.list(scope, showDeleted),
      folders: () => fileKeys.folders(scope),
      detail: (key) => fileKeys.detail(scope, key),
    },
    list: (showDeleted) => api.listFiles(scope, showDeleted),
    listFolders: () => api.listFolders(scope),
    get: (key) => api.getFile(scope, key),
    write: (key, mediaType, text) => api.writeFile(scope, key, mediaType, text),
    remove: (key) => api.deleteFile(scope, key),
    restore: (key, seq) => api.restoreFile(scope, key, seq),
    createFolder: (path) => api.createFolder(scope, path),
    renameFolder: (path, to) => api.renameFolder(scope, path, to),
    deleteFolder: (path) => api.deleteFolder(scope, path),
    upload: (file, mediaType, name) =>
      api.uploadFile(scope, file, mediaType, { name }),
  };
}
