import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { isCovered } from "./workspace-ticks.js";

/*
 * What a workspace shows to a helper (workspaces and .gitignore design).
 * A path is shown when it is not ignored by the folder's .gitignore files
 * (if the workspace respects them) and is not hidden in a scope the session
 * sees. The same answer is used by the search scan, the tool results and the
 * Files tree's "ignored" mark.
 */

/** The files git reads for its own ignore rules at the top of a repository. */
const EXCLUDE = join(".git", "info", "exclude");

export interface GitignoreMatcher {
  /** Whether a path inside the folder is ignored, or is inside an ignored folder. */
  ignored(rel: string): boolean;
}

/**
 * Matches paths against the `.gitignore` files of a folder: each one applies
 * below its own folder and a deeper one wins over a higher one, and
 * `.git/info/exclude` is the lowest. `.git` is always ignored. An ignored
 * folder ignores what is inside it. The files are read as needed and kept for
 * the life of the matcher, so make a new one for each operation.
 */
export function createGitignore(root: string): GitignoreMatcher {
  const cache = new Map<string, Ignore | null>();
  const load = (key: string, file: string): Ignore | null => {
    if (!cache.has(key)) {
      try {
        cache.set(key, ignore().add(readFileSync(file, "utf8")));
      } catch {
        cache.set(key, null); // no such file, or not readable
      }
    }
    return cache.get(key) ?? null;
  };
  const isDir = (rel: string): boolean =>
    statSync(join(root, rel), { throwIfNoEntry: false })?.isDirectory() ??
    false;

  return {
    ignored(rel) {
      const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
      if (parts.includes(".git")) return true;
      const exclude = load("", join(root, EXCLUDE));
      for (let i = 0; i < parts.length; i++) {
        const dir = i === parts.length - 1 ? isDir(parts.join("/")) : true;
        let ignored = false;
        const test = (ig: Ignore | null, from: number) => {
          if (!ig) return;
          const path = parts.slice(from, i + 1).join("/") + (dir ? "/" : "");
          const r = ig.test(path);
          if (r.ignored) ignored = true;
          else if (r.unignored) ignored = false;
        };
        test(exclude, 0);
        for (let from = 0; from <= i; from++) {
          const folder = parts.slice(0, from).join("/");
          test(load(`/${folder}`, join(root, folder, ".gitignore")), from);
        }
        if (ignored) return true;
      }
      return false;
    },
  };
}

/** Whether a path is hidden: it is, or is inside, a hidden path. */
export const isHidden = (hidden: readonly string[], path: string): boolean =>
  hidden.length > 0 && isCovered(hidden, path);

/**
 * The paths of a workspace a session may see: not ignored by the folder's
 * .gitignore files (when the workspace respects them) and not hidden.
 */
export function visibilityOf(
  w: { path: string; respectGitignore: boolean },
  hidden: readonly string[],
): (rel: string) => boolean {
  const ig = w.respectGitignore ? createGitignore(w.path) : null;

  return (rel) => !isHidden(hidden, rel) && !(ig?.ignored(rel) ?? false);
}
