import { z } from "zod";
import { defineTool, type RunSkill, type SkillScope } from "@harness/core";

/*
 * Skills (skills design). The system message lists each skill in scope with
 * its description (decisions 6, 11); one tool loads a body (decision 8). It
 * does not ask (decision 10) and is not part of an agent's tool selection
 * (decision 9, set up where the tools are wired).
 */

export const SKILL_LOAD = "skill_load";

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
    "Loads the full instructions of one of the skills listed in the system message. Call it when the user's request matches a skill's description, then follow the instructions it returns. Give the skill's name as listed; give the scope too only when two listed skills share a name.",
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
    return {
      data:
        skill.body.trim() === ""
          ? `The skill "${skill.name}" has no instructions.`
          : skill.body,
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

/**
 * The skill list for the system message with its introduction (skills
 * decisions 6, 8, 11), or undefined when no skill is in scope. It is used
 * where no prompt has `{{skills}}` (placeholders design, decision 10). The
 * wording is Claude's draft, for review.
 */
export function skillsInstruction(
  skills: readonly RunSkill[],
): string | undefined {
  if (skills.length === 0) return undefined;
  const shared = [...byName(skills).values()].some((s) => s.length > 1);
  return [
    `You have skills: written instructions for particular kinds of work. When the user's request matches a skill's description, call ${SKILL_LOAD} with its name before you start, then follow what it returns.${
      shared
        ? " When two skills share a name, give the scope too, shown in brackets."
        : ""
    }`,
    "",
    skillsList(skills),
  ].join("\n");
}
