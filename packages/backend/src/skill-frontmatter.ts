import { parse, stringify } from "yaml";

/*
 * SKILL.md: YAML frontmatter, then the instructions (skills folders design,
 * decisions 2, 13, 14). Only `name` and `description` are checked; every other
 * key is kept exactly as written, so a skill from another harness keeps what
 * that harness put in it.
 */

/** The longest skill name (Agent Skills spec). */
export const MAX_NAME = 64;
/** The longest description (Agent Skills spec). */
export const MAX_DESCRIPTION = 1024;

/** Lowercase letters, digits and single hyphens, none at either end. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a skill name is not valid, or undefined when it is. */
export function skillNameProblem(name: string): string | undefined {
  if (name === "") return "The name is empty.";
  if (name.length > MAX_NAME) {
    return `The name is ${name.length} characters; the most is ${MAX_NAME}.`;
  }
  if (!NAME.test(name)) {
    return "Use lowercase letters, digits and single hyphens, with no hyphen at either end.";
  }
  return undefined;
}

/** A SKILL.md that cannot be saved; the message says why. */
export class SkillFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFileError";
  }
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  /** The frontmatter as written, between the two `---` lines. */
  frontmatter: string;
  /** What follows the frontmatter, as written. */
  instructions: string;
}

const FENCE = /^---[ \t]*\r?\n/;

/**
 * Splits SKILL.md into its frontmatter and instructions, checking `name` and
 * `description`. Throws `SkillFileError` for a file with no frontmatter,
 * frontmatter that is not a YAML mapping, or a name or description that is
 * missing or not allowed.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const open = FENCE.exec(text);
  if (!open) {
    throw new SkillFileError(
      "SKILL.md must start with a --- line and frontmatter that gives the skill's name and description.",
    );
  }
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) {
    throw new SkillFileError("The frontmatter in SKILL.md has no closing ---.");
  }
  const frontmatter = rest.slice(0, close.index);
  const instructions = rest.slice(close.index + close[0].length);
  let data: unknown;
  try {
    data = parse(frontmatter);
  } catch (err) {
    throw new SkillFileError(
      `The frontmatter in SKILL.md is not valid YAML: ${(err as Error).message.split("\n")[0]}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SkillFileError(
      "The frontmatter in SKILL.md must be YAML keys and values.",
    );
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string") {
    throw new SkillFileError("The frontmatter needs a name.");
  }
  const problem = skillNameProblem(name);
  if (problem) throw new SkillFileError(problem);
  if (typeof description !== "string" || description.trim() === "") {
    throw new SkillFileError("The frontmatter needs a description.");
  }
  if (description.trim().length > MAX_DESCRIPTION) {
    throw new SkillFileError(
      `The description is ${description.trim().length} characters; the most is ${MAX_DESCRIPTION}.`,
    );
  }
  return {
    name,
    description: description.trim(),
    frontmatter,
    instructions,
  };
}

/** A new SKILL.md from a name, a description and instructions. */
export function buildSkillFile(
  name: string,
  description: string,
  instructions: string,
): string {
  const front = stringify({ name, description: description.trim() }).trimEnd();
  return `---\n${front}\n---\n\n${instructions.replace(/^\n+/, "")}`;
}

/**
 * The same SKILL.md under another name: only the `name` line of the
 * frontmatter changes, so every other key and its formatting stay as written
 * (decision 4). Throws when the frontmatter has no top-level `name` line.
 */
export function renameInSkillFile(text: string, name: string): string {
  const parsed = parseSkillFile(text);
  const lines = parsed.frontmatter.split(/(?<=\n)/);
  const at = lines.findIndex((l) => /^name[ \t]*:/.test(l));
  if (at < 0) {
    throw new SkillFileError(
      "The frontmatter's name is not on a line of its own, so it cannot be renamed here.",
    );
  }
  const newline = lines[at]?.endsWith("\r\n") ? "\r\n" : "\n";
  lines[at] = `name: ${name}${lines[at]?.endsWith("\n") ? newline : ""}`;
  const open = FENCE.exec(text);
  const head = open ? open[0] : "---\n";
  const rest = text.slice(head.length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  const tail = close ? rest.slice(close.index) : "";
  return `${head}${lines.join("")}${tail}`;
}

/** The text of SKILL.md without its frontmatter, trimmed at the top. */
export function instructionsOf(text: string): string {
  return parseSkillFile(text).instructions.replace(/^\r?\n+/, "");
}
