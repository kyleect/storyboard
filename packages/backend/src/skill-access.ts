import type { SkillFileAccess } from "@harness/core";
import { isTextType, type SkillStore } from "./skills-store.js";

/*
 * What a run reads of a skill's folder (skills folders design, decision 12):
 * the files as of the version the run pinned when it started, so a skill
 * edited during the run changes nothing for it.
 */
export function skillFileAccess(skills: SkillStore): SkillFileAccess {
  return {
    read(skill, path) {
      const file = skills.readFile(skill.id, path, skill.version);
      if (!file) return undefined;
      const { mediaType, size } = file;
      if (file.data === null) return { kind: "missing", mediaType, size };
      if (isTextType(mediaType)) {
        return {
          kind: "text",
          mediaType,
          size,
          text: file.data.toString("utf-8"),
        };
      }
      return { kind: "binary", mediaType, size };
    },
  };
}
