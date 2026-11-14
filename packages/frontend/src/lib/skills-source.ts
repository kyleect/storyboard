import type { MediaType } from "@harness/core";
import {
  api,
  type FileDetail,
  type FileVersion,
  type SkillFileInfo,
  type SkillOwner,
  type SkillWithFiles,
  type StoredFile,
} from "../api";
import type { ExplorerSource } from "./explorer-source";
import { skillKeys } from "../queries";

export const NEW_SKILL_DESCRIPTION =
  "Describe what this skill does and when to use it.";

export async function findSkill(
  owner: SkillOwner,
  part: SkillsPart,
  name: string,
): Promise<SkillWithFiles> {
  const all = (await api.listSkillTree(owner, true)).filter((s) =>
    part === "builtin" ? s.scope === "builtin" : s.scope !== "builtin",
  );
  const found =
    all.find((s) => s.name === name && !s.deleted) ??
    all.find((s) => s.name === name);
  if (!found) throw new Error(`There is no skill named “${name}”.`);
  return found;
}

export function splitKey(key: string): [string, string] {
  const at = key.indexOf("/");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

const TEXT_TYPES = ["text/plain", "text/markdown", "application/json"] as const;

function shownType(mediaType: string): MediaType | undefined {
  const text = TEXT_TYPES.find((t) => t === mediaType);
  if (text) return text;
  if (mediaType.startsWith("text/")) return "text/plain";
  return /^(image\/(png|jpeg|gif|bmp)|audio\/(wav|mpeg|flac))$/.test(mediaType)
    ? (mediaType as MediaType)
    : undefined;
}

const isText = (mediaType: MediaType | undefined) =>
  mediaType !== undefined &&
  (TEXT_TYPES as readonly string[]).includes(mediaType);

function note(f: Pick<SkillFileInfo, "missing" | "size">): string {
  return f.missing
    ? "The bytes of this version are no longer stored. A binary file keeps its last three contents."
    : `A binary file of ${f.size} bytes that cannot be shown here.`;
}

function fileView(
  f: SkillFileInfo,
  value: string,
): Pick<StoredFile, "mediaType" | "value" | "blob"> {
  const mediaType = shownType(f.mediaType);
  if (isText(mediaType)) {
    return { ...(mediaType ? { mediaType } : {}), value };
  }
  if (mediaType && f.hash) {
    return { mediaType, value: "", blob: { hash: f.hash, size: f.size } };
  }
  return { value: note(f) };
}

export type SkillsPart = "builtin" | "own";

export function skillsSource(
  owner: SkillOwner,
  part: SkillsPart = "own",
): ExplorerSource {
  const mine = (s: SkillWithFiles) =>
    part === "builtin" ? s.scope === "builtin" : s.scope !== "builtin";
  const tree = async (showDeleted: boolean) =>
    (await api.listSkillTree(owner, showDeleted)).filter(mine);
  const skillNamed = (name: string) => findSkill(owner, part, name);
  const inSkill = async (key: string) => {
    const [name, path] = splitKey(key);
    if (path === "") {
      throw new Error(
        "A file belongs inside a skill folder. Create a skill first, then add the file to it.",
      );
    }
    return { skill: await skillNamed(name), path };
  };

  const get = async (key: string): Promise<FileDetail> => {
    const { skill, path } = await inSkill(key);
    const detail = await api.getSkill(skill.id);
    const now = detail.files.find((f) => f.path === path);
    const versions = (
      await Promise.all(
        detail.versions.map(async (v): Promise<FileVersion | undefined> => {
          try {
            const at = await api.getSkillFile(skill.id, path, v.seq);
            const view = fileView(at, at.value);
            return {
              seq: v.seq,
              ...view,
              deleted: v.deleted,
              by: "user",
              sessionId: null,
              runId: null,
              createdAt: v.createdAt,
            };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((v): v is FileVersion => v !== undefined);
    if (!now) {
      const last = versions.at(-1);
      if (!last) throw new Error(`There is no file “${key}”.`);
      return {
        key,
        ...(last.mediaType ? { mediaType: last.mediaType } : {}),
        value: last.value,
        ...(last.blob ? { blob: last.blob } : {}),
        updatedAt: detail.updatedAt,
        deleted: true,
        versions,
      };
    }
    const current = await api.getSkillFile(skill.id, path);
    return {
      key,
      ...fileView(current, current.value),
      updatedAt: detail.updatedAt,
      deleted: skill.deleted,
      versions,
    };
  };

  return {
    keys: {
      all: skillKeys.treeOf(owner, part),
      list: (showDeleted) => skillKeys.tree(owner, part, showDeleted),
      folders: () => [...skillKeys.treeOf(owner, part), "folders"] as const,
      detail: (key) => skillKeys.fileOf(owner, part, key),
    },
    accepts: { anyType: true },
    list: async (showDeleted) =>
      (await tree(showDeleted)).flatMap((s) =>
        s.files.map((f): StoredFile => ({
          key: `${s.name}/${f.path}`,
          ...fileView(f, ""),
          updatedAt: s.updatedAt,
          deleted: s.deleted,
        })),
      ),
    listFolders: async () => [],
    get,
    write: async (key, _mediaType, text) => {
      const { skill, path } = await inSkill(key);
      await api.putSkillFile(skill.id, path, text);
      return get(key);
    },
    remove: async (key) => {
      const { skill, path } = await inSkill(key);
      return api.deleteSkillPath(skill.id, path);
    },
    restore: async (key, seq) => {
      const { skill } = await inSkill(key);
      return api.restoreSkill(skill.id, seq);
    },
    createFolder: async (path) => {
      if (path.includes("/")) {
        throw new Error(
          "A folder inside a skill appears once it has a file. Create a file with the folder in its name, such as refs/notes.md.",
        );
      }
      return api.createSkill(owner, {
        name: path,
        description: NEW_SKILL_DESCRIPTION,
        body: "",
      });
    },
    renameFolder: async (path, to) => {
      const [name, inner] = splitKey(path);
      const [newName, newInner] = splitKey(to);
      const skill = await skillNamed(name);
      if (inner === "" && newInner === "") {
        return api.renameSkill(skill.id, newName);
      }
      if (name !== newName || inner === "" || newInner === "") {
        throw new Error(
          "A file or folder can be renamed inside its skill, but not moved to another skill or out of it.",
        );
      }
      return api.moveSkillPath(skill.id, inner, newInner);
    },
    deleteFolder: async (path) => {
      const [name, inner] = splitKey(path);
      const skill = await skillNamed(name);
      return inner === ""
        ? api.deleteSkill(skill.id)
        : api.deleteSkillPath(skill.id, inner);
    },
    upload: async (file, _mediaType, name) => {
      const { skill, path } = await inSkill(name);
      await api.putSkillFileBytes(skill.id, path, file);
      return { key: name };
    },
  };
}
