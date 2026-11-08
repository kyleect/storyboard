/*
 * Names of files and folders (files unification design, D37, D50, D51).
 *
 * A path is one or more names separated by "/". Each name:
 * - has no control characters,
 * - is not "." or "..",
 * - does not end in a dot or a space,
 * - is not a name Windows reserves (CON, NUL, COM1 and so on, with or
 *   without an extension),
 * - is at most 255 characters.
 * Names are kept and compared exactly as typed: case-sensitive, no Unicode
 * normalisation (D51). The rules apply to names being created; a name that
 * is already stored stays valid.
 */

export const MAX_NAME_LENGTH = 255;

/** Windows device names; matched on the part before the first dot. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The problem with one name, or undefined when it is fine. `path` is for the
 * message only.
 */
function problemWithName(name: string): string | undefined {
  if (name === "") return "a name is empty";
  if (name === "." || name === "..") return `"${name}" is not allowed`;
  if (CONTROL.test(name)) return "it has a control character";
  if (name.endsWith(".") || name.endsWith(" "))
    return "a name cannot end in a dot or a space";
  if (RESERVED.test(name.split(".")[0] ?? ""))
    return `"${name}" is a name Windows reserves`;
  if ([...name].length > MAX_NAME_LENGTH)
    return `a name is longer than ${MAX_NAME_LENGTH} characters`;
  return undefined;
}

/** The problem with a path, or undefined when it is fine. */
export function fileNameProblem(path: string): string | undefined {
  if (path === "") return "it is empty";
  for (const name of path.split("/")) {
    const problem = problemWithName(name);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * The folders above a path, outermost first: "a/b/c.md" gives "a" and
 * "a/b". Empty for a name at the top level.
 */
export function parentFolders(path: string): string[] {
  const names = path.split("/");
  return names.slice(0, -1).map((_, i) => names.slice(0, i + 1).join("/"));
}

/** The path a name has in a folder; the top level is the empty folder. */
export const joinPath = (folder: string, name: string): string =>
  folder === "" ? name : `${folder}/${name}`;

/** True when `path` is `folder` or inside it. */
export const isInFolder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);
