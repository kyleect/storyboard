import type { MediaType } from "@harness/core";
import {
  api,
  type FileDetail,
  type FileScope,
  type StoredFile,
  type UploadedFile,
} from "./api";
import { fileKeys } from "./queries";
import type { RootId } from "./explorer";

/*
 * Where an editor-style explorer gets its files from. The tree, the tabs and
 * the editor never call the API themselves; they ask the `ExplorerSource` of
 * the root a file is in. Files have one source per scope (`filesSource`);
 * skills bring their own. A source also names its query keys, built with the
 * feature's key factory, so a change refreshes exactly what it touched.
 */

export interface ExplorerSource {
  /** Query keys for everything this source caches. */
  keys: {
    /** Every list, folder list and file of the source. */
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
  /**
   * What an upload may be. Left out: the attachment types and size the
   * Files view takes. A skill takes any file, and the backend checks its
   * caps (settings) and says why when it refuses one.
   */
  accepts?: { anyType: true };
  /** Stores an accepted file under `name`; resolves to the key it got. */
  upload: (
    file: File,
    mediaType: string,
    name: string,
  ) => Promise<Pick<UploadedFile, "key">>;
}

/** A root folder of an explorer's tree, with where its files come from. */
export interface ExplorerRoot {
  id: RootId;
  label: string;
  source: ExplorerSource;
  /** Why nothing in the root can be changed; undefined when it can. */
  readOnly?: string | undefined;
  /**
   * Saving here reaches more than the page being edited from does. Set, it
   * makes a save ask first and shows this as the reason.
   */
  broadNote?: string | undefined;
}

/** The files of one scope. */
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
