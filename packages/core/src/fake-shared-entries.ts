import type {
  EntryAuthor,
  SharedEntries,
  SharedEntry,
  SharedScope,
} from "./entries.js";
import type { EntryKind, FileType } from "./messages.js";

/** A change recorded by `FakeSharedEntries`. */
export interface FakeSharedChange {
  kind: EntryKind;
  scope: SharedScope;
  key: string;
  op: "put" | "delete";
  author: EntryAuthor;
}

/** In-memory project and global entries, for tests. */
export class FakeSharedEntries implements SharedEntries {
  private readonly rows = new Map<string, SharedEntry | null>();
  readonly changes: FakeSharedChange[] = [];
  private clock = 0;

  private id = (kind: EntryKind, scope: SharedScope, key: string) =>
    `${kind}\u0000${scope}\u0000${key}`;

  list(kind: EntryKind, scope: SharedScope): SharedEntry[] {
    const prefix = this.id(kind, scope, "");
    return [...this.rows]
      .filter(([id, row]) => id.startsWith(prefix) && row !== null)
      .map(([, row]) => row as SharedEntry);
  }

  get(kind: EntryKind, scope: SharedScope, key: string) {
    return this.rows.get(this.id(kind, scope, key)) ?? undefined;
  }

  exists(kind: EntryKind, scope: SharedScope, key: string) {
    return this.rows.has(this.id(kind, scope, key));
  }

  put(
    kind: EntryKind,
    scope: SharedScope,
    entry: { key: string; value: string; type?: FileType },
    author: EntryAuthor,
  ) {
    this.rows.set(this.id(kind, scope, entry.key), {
      ...entry,
      updatedAt: String(++this.clock),
    });
    this.changes.push({ kind, scope, key: entry.key, op: "put", author });
  }

  delete(
    kind: EntryKind,
    scope: SharedScope,
    key: string,
    author: EntryAuthor,
  ) {
    const id = this.id(kind, scope, key);
    if (!this.rows.get(id)) return false;
    this.rows.set(id, null);
    this.changes.push({ kind, scope, key, op: "delete", author });
    return true;
  }
}
