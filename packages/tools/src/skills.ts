import { z } from "zod";
import { defineTool, type RunSkill, type SkillScope } from "@harness/core";

/*
 * Skills (skills design; skills folders design). The system message lists
 * each skill in scope with its description (decisions 6, 11); one tool loads
 * a skill's instructions, or reads one of the other files in its folder
 * (folders design, decision 12). It does not ask (decision 10) and is not
 * part of an agent's tool selection (decision 9, set up where the tools are
 * wired).
 */

export const SKILL_LOAD = "skill_load";

/** The file every skill has; the instructions come from it. */
const SKILL_FILE = "SKILL.md";

/** The most characters one read returns; `offset` reads on (decision 12). */
export const SKILL_READ_CHARS = 20_000;

const SCOPES = [
  "builtin",
  "global",
  "project",
  "agent",
] as const satisfies SkillScope[];

/** Names the model can use for a skill, with the scopes it is defined in. */
function byName(skills: readonly RunSkill[]): Map<string, RunSkill[]> {
  const names = new Map<string, RunSkill[]>();
  for (const s of skills) names.set(s.name, [...(names.get(s.name) ?? []), s]);
  return names;
}

export const skillLoad = defineTool({
  name: SKILL_LOAD,
  description:
    "Loads the full instructions of one of the skills listed in the system message. Call it when the user's request matches a skill's description, then follow the instructions it returns. The result lists the other files in the skill's folder; read one by calling again with its path. Give the skill's name as listed; give the scope too only when two listed skills share a name.",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe("The skill's name, as listed in the system message."),
    scope: z
      .enum(SCOPES)
      .optional()
      .describe("Only when two listed skills have the same name."),
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "A file in the skill's folder, as listed in the instructions. Leave out to load the instructions.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional()
      .describe("With path: the character to start reading from."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SKILL_READ_CHARS)
      .optional()
      .describe(
        `With path: the most characters to return (at most ${SKILL_READ_CHARS}).`,
      ),
  }),
  approval: "never",
  group: "skills",
  alwaysOn: true,
  available: (run) => run.hasSkills,
  execute: (input, ctx) => {
    const name = input.name.trim();
    const named = byName(ctx.skills).get(name) ?? [];
    const matches = input.scope
      ? named.filter((s) => s.scope === input.scope)
      : named;
    if (matches.length === 0) {
      const available = [...byName(ctx.skills).keys()];
      return {
        isError: true,
        data:
          named.length > 0
            ? `The skill "${name}" is not defined in the ${input.scope} scope. It is defined in: ${named.map((s) => s.scope).join(", ")}.`
            : `No skill named "${name}" is available.${
                available.length > 0
                  ? ` Available skills: ${available.join(", ")}.`
                  : ""
              }`,
      };
    }
    if (matches.length > 1) {
      return {
        isError: true,
        data: `Two skills are named "${name}" (${matches.map((s) => s.scope).join(", ")}). Call again with the scope.`,
      };
    }
    const skill = matches[0] as RunSkill;
    if (input.path === undefined) {
      const others = skill.files.filter((f) => f.path !== SKILL_FILE);
      const body =
        skill.instructions.trim() === ""
          ? `The skill "${skill.name}" has no instructions.`
          : skill.instructions;
      return {
        data:
          others.length === 0
            ? body
            : `${body}\n\nOther files in this skill (read one with path):\n${others
                .map((f) => `- ${f.path} (${f.mediaType}, ${f.size} bytes)`)
                .join("\n")}`,
      };
    }
    const path = input.path.replace(/^\.?\//, "");
    const read = ctx.skillFiles.read(skill, path);
    if (!read) {
      return {
        isError: true,
        data: `The skill "${skill.name}" has no file "${path}". Its files: ${skill.files
          .map((f) => f.path)
          .join(", ")}.`,
      };
    }
    if (read.kind === "missing") {
      return {
        isError: true,
        data: `The file "${path}" is in the skill but its contents are no longer stored.`,
      };
    }
    if (read.kind === "binary") {
      return {
        data: {
          path,
          mediaType: read.mediaType,
          size: read.size,
          guidance: "This is a binary file, so there is no text to read.",
        },
      };
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? SKILL_READ_CHARS;
    const text = read.text.slice(offset, offset + limit);
    const end = offset + text.length;
    return {
      data: {
        path,
        mediaType: read.mediaType,
        totalCharacters: read.text.length,
        offset,
        text,
        ...(end < read.text.length
          ? {
              guidance: `Cut off at character ${end} of ${read.text.length}. Call again with offset ${end} to read on.`,
            }
          : {}),
      },
    };
  },
});

export const skillTools = [skillLoad];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The skills in scope, one per line with its description; a scope is shown
 * only for a name that is in more than one scope (skills decisions 2, 6). It
 * is what `{{skills}}` expands to (placeholders design, decisions 8, 9).
 * Empty when there are none.
 */
export function skillsList(skills: readonly RunSkill[]): string {
  const names = byName(skills);
  return skills
    .map((s) => {
      const label =
        (names.get(s.name)?.length ?? 0) > 1
          ? `${s.name} (${s.scope})`
          : s.name;
      return `- ${label}: ${oneLine(s.description)}`;
    })
    .join("\n");
}
