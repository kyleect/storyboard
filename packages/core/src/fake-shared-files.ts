import type {
  FileAuthor,
  SharedFiles,
  SharedFile,
  SharedScope,
} from "./files.js";
import { isInFolder } from "./file-names.js";
import type { BlobRef, MediaType } from "./messages.js";

/** A change recorded by `FakeSharedFiles`. */
export interface FakeSharedChange {
  scope: SharedScope;
  key: string;
  op: "put" | "delete";
  author: FileAuthor;
}

/** In-memory project and global files, for tests. */
export class FakeSharedFiles implements SharedFiles {
  private readonly rows = new Map<string, SharedFile | null>();
  readonly changes: FakeSharedChange[] = [];
  private clock = 0;

  private id = (scope: SharedScope, key: string) => `${scope}\u0000${key}`;

  list(scope: SharedScope): SharedFile[] {
    const prefix = this.id(scope, "");
    return [...this.rows]
      .filter(([id, row]) => id.startsWith(prefix) && row !== null)
      .map(([, row]) => row as SharedFile);
  }

  get(scope: SharedScope, key: string) {
    return this.rows.get(this.id(scope, key)) ?? undefined;
  }

  put(
    scope: SharedScope,
    file: {
      key: string;
      value: string;
      mediaType?: MediaType;
      blob?: BlobRef;
    },
    author: FileAuthor,
  ) {
    this.rows.set(this.id(scope, file.key), {
      ...file,
      updatedAt: String(++this.clock),
    });
    this.changes.push({ scope, key: file.key, op: "put", author });
  }

  delete(scope: SharedScope, key: string, author: FileAuthor) {
    const id = this.id(scope, key);
    if (!this.rows.get(id)) return false;
    this.rows.set(id, null);
    this.changes.push({ scope, key, op: "delete", author });
    return true;
  }

  private readonly folders = new Map<SharedScope, Set<string>>();

  private folderSet(scope: SharedScope): Set<string> {
    let set = this.folders.get(scope);
    if (!set) this.folders.set(scope, (set = new Set()));
    return set;
  }

  listFolders(scope: SharedScope): string[] {
    return [...this.folderSet(scope)];
  }

  createFolder(scope: SharedScope, path: string) {
    this.folderSet(scope).add(path);
  }

  renameFolder(
    scope: SharedScope,
    from: string,
    to: string,
    author: FileAuthor,
  ) {
    const rename = (path: string) => `${to}${path.slice(from.length)}`;
    for (const file of this.list(scope)) {
      if (!isInFolder(file.key, from)) continue;
      this.put(scope, { ...file, key: rename(file.key) }, author);
      this.delete(scope, file.key, author);
    }
    const set = this.folderSet(scope);
    for (const f of [...set].filter((f) => isInFolder(f, from))) {
      set.delete(f);
      set.add(rename(f));
    }
    if (!set.has(to)) set.add(to);
  }

  deleteFolder(scope: SharedScope, path: string, author: FileAuthor) {
    for (const file of this.list(scope)) {
      if (isInFolder(file.key, path)) {
        this.delete(scope, file.key, author);
      }
    }
    const set = this.folderSet(scope);
    for (const f of [...set]) if (isInFolder(f, path)) set.delete(f);
  }
}
