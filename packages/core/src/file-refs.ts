/*
 * References to files (files unification design, D5, D7, D34, D52).
 *
 * A reference names where a file is and its path there:
 *
 *   session://notes.md
 *   project://characters/alice.md
 *   global://My Photo.png
 *   workspace://<id>/chapters/one.md
 *
 * Written in text (a message, a task, a tool result) a reference is always
 * in angle brackets with the plain name inside: <session://My Photo.png>.
 * Tools accept the plain form, with or without brackets.
 *
 * This is not a URL parser: a standard parser reads the first segment after
 * "//" as a host and rejects names with spaces (D5). A name that contains
 * ">" cannot be written inside brackets, because ">" ends the reference.
 */

export const REF_SCOPES = ["session", "project", "global"] as const;

export type FileRef =
  | { location: (typeof REF_SCOPES)[number]; path: string }
  | { location: "workspace"; workspaceId: string; path: string };

const SCHEMES = [...REF_SCOPES, "workspace"] as const;

/** The reference as plain text, without brackets: how tools take it. */
export function plainRef(ref: FileRef): string {
  return ref.location === "workspace"
    ? `workspace://${ref.workspaceId}/${ref.path}`
    : `${ref.location}://${ref.path}`;
}

/** The reference as written in text: in angle brackets. */
export const formatRef = (ref: FileRef): string => `<${plainRef(ref)}>`;

/**
 * Reads one reference from a whole string, with or without angle brackets.
 * Undefined when the text is not a reference. A scope reference needs a path;
 * a workspace reference needs an id and may have an empty path (its root).
 */
export function parseRef(text: string): FileRef | undefined {
  const inner =
    text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;
  for (const scheme of SCHEMES) {
    const prefix = `${scheme}://`;
    if (!inner.startsWith(prefix)) continue;
    const rest = inner.slice(prefix.length);
    if (scheme === "workspace") {
      const slash = rest.indexOf("/");
      const workspaceId = slash === -1 ? rest : rest.slice(0, slash);
      if (workspaceId === "") return undefined;
      return {
        location: "workspace",
        workspaceId,
        path: slash === -1 ? "" : rest.slice(slash + 1),
      };
    }
    return rest === "" || rest.includes(">")
      ? undefined
      : { location: scheme, path: rest };
  }
  return undefined;
}

/** Every reference written in angle brackets in a text, in order. */
export function findRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  for (const match of text.matchAll(
    /<((?:session|project|global|workspace):\/\/[^>\n]+)>/g,
  )) {
    const ref = parseRef(match[1] ?? "");
    if (ref) refs.push(ref);
  }
  return refs;
}
