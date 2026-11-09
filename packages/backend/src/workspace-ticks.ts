/*
 * What the user chose to search in a workspace (files unification design,
 * D45, D53): a set of paths inside its folder. A ticked folder includes every
 * file inside it, now and later; "" is the whole folder. The set is kept
 * small: a path under a ticked folder is not listed.
 */

/** A tick as a clean relative path: no `..`, no leading or trailing `/`. */
export function normalizeTick(path: string): string {
  if (path.includes("\0"))
    throw new Error("A path cannot contain a null character.");
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) {
    throw new Error("A path cannot go up with `..`.");
  }
  return parts.join("/");
}

/** True when `path` is `folder` or inside it. `""` is every path's folder. */
export const isUnder = (path: string, folder: string): boolean =>
  folder === "" || path === folder || path.startsWith(`${folder}/`);

const join = (folder: string, name: string) =>
  folder === "" ? name : `${folder}/${name}`;

/** Cleans the paths, drops duplicates and those inside another, and sorts. */
export function normalizeTicks(paths: readonly string[]): string[] {
  const clean = [...new Set(paths.map(normalizeTick))];
  return clean
    .filter((p) => !clean.some((q) => q !== p && isUnder(p, q)))
    .sort();
}

/** Whether a path is searched: ticked itself or inside a ticked folder. */
export const isCovered = (ticks: readonly string[], path: string): boolean =>
  ticks.some((t) => isUnder(path, t));

/**
 * What a tree shows for a path: `all` (covered), `some` (something inside it
 * is ticked) or `none`.
 */
export function tickState(
  ticks: readonly string[],
  path: string,
): "all" | "some" | "none" {
  if (isCovered(ticks, path)) return "all";
  return ticks.some((t) => isUnder(t, path)) ? "some" : "none";
}

/**
 * Ticks or unticks one path. Unticking a path inside a ticked folder ticks
 * the folder's other entries instead, so only that path leaves; `children`
 * lists the entry paths of a folder for that.
 */
export function toggleTick(
  ticks: readonly string[],
  path: string,
  on: boolean,
  children: (folder: string) => string[],
): string[] {
  const target = normalizeTick(path);
  if (on) return normalizeTicks([...ticks, target]);
  const covering = ticks.find((t) => isUnder(target, t));
  if (covering === undefined) {
    // Not covered: drop what is ticked inside it.
    return normalizeTicks(ticks.filter((t) => !isUnder(t, target)));
  }
  const out = ticks.filter((t) => t !== covering);
  if (covering !== target) {
    const below = target.slice(covering === "" ? 0 : covering.length + 1);
    let folder = covering;
    for (const segment of below.split("/")) {
      const next = join(folder, segment);
      for (const child of children(folder)) if (child !== next) out.push(child);
      folder = next;
    }
  }
  return normalizeTicks(out);
}
