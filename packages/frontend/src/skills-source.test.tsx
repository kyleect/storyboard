import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type SkillDetail,
  type SkillFileInfo,
  type SkillWithFiles,
} from "./api";
import { skillKeys } from "./queries";
import { NEW_SKILL_DESCRIPTION, skillsSource, splitKey } from "./skills-source";

afterEach(() => vi.restoreAllMocks());

const GLOBAL = { scope: "global" } as const;
const at = "2026-11-13T10:00:00Z";

const info = (over: Partial<SkillFileInfo> = {}): SkillFileInfo => ({
  path: "SKILL.md",
  mediaType: "text/markdown",
  size: 40,
  missing: false,
  hash: "h-skill",
  ...over,
});

const skill = (over: Partial<SkillWithFiles> = {}): SkillWithFiles => ({
  id: "k1",
  name: "outline",
  description: "Use for outlines.",
  scope: "global",
  projectId: null,
  agentId: null,
  version: 2,
  createdAt: at,
  updatedAt: at,
  deleted: false,
  files: [info(), info({ path: "refs/guide.md", hash: "h-guide" })],
  ...over,
});

const detail = (s: SkillWithFiles): SkillDetail => ({
  ...s,
  body: "",
  versions: [
    {
      seq: 1,
      name: s.name,
      description: s.description,
      deleted: false,
      createdAt: at,
      fileCount: 1,
      totalSize: 40,
    },
    {
      seq: 2,
      name: s.name,
      description: s.description,
      deleted: false,
      createdAt: at,
      fileCount: 2,
      totalSize: 80,
    },
  ],
});

const tree = (...skills: SkillWithFiles[]) =>
  vi.spyOn(api, "listSkillTree").mockResolvedValue(skills);

describe("splitKey", () => {
  it("splits a key into the skill and the path inside it", () => {
    expect(splitKey("outline/refs/a.md")).toEqual(["outline", "refs/a.md"]);
    expect(splitKey("outline")).toEqual(["outline", ""]);
  });
});

describe("skillsSource", () => {
  it("names its query keys with the skills key factory", () => {
    const s = skillsSource(GLOBAL, "builtin");
    expect(s.keys.all).toEqual(skillKeys.treeOf(GLOBAL, "builtin"));
    expect(s.keys.list(true)).toEqual(skillKeys.tree(GLOBAL, "builtin", true));
    // Every key is under the skills root, so skills.changed refreshes it.
    expect(s.keys.detail("a/b").slice(0, 1)).toEqual(["skills"]);
    expect(s.keys.folders().slice(0, 1)).toEqual(["skills"]);
  });

  it("lists each skill's files under the skill's name", async () => {
    tree(skill());
    const files = await skillsSource(GLOBAL).list(false);
    expect(files.map((f) => f.key)).toEqual([
      "outline/SKILL.md",
      "outline/refs/guide.md",
    ]);
    expect(files[0]).toMatchObject({
      mediaType: "text/markdown",
      deleted: false,
    });
  });

  it("splits built-in skills from the owner's own", async () => {
    tree(skill({ id: "b", name: "builtin-tasks", scope: "builtin" }), skill());
    const builtin = await skillsSource(GLOBAL, "builtin").list(false);
    const own = await skillsSource(GLOBAL, "own").list(false);
    expect(builtin.every((f) => f.key.startsWith("builtin-tasks/"))).toBe(true);
    expect(own.every((f) => f.key.startsWith("outline/"))).toBe(true);
  });

  it("marks a deleted skill's files deleted", async () => {
    tree(skill({ deleted: true }));
    const files = await skillsSource(GLOBAL).list(true);
    expect(files.every((f) => f.deleted)).toBe(true);
  });

  it("shows images by their blob, other binaries as a note", async () => {
    tree(
      skill({
        files: [
          info(),
          info({
            path: "logo.png",
            mediaType: "image/png",
            hash: "h-png",
            size: 9,
          }),
          info({
            path: "data.bin",
            mediaType: "application/octet-stream",
            size: 7,
          }),
          info({
            path: "old.png",
            mediaType: "image/png",
            hash: null,
            missing: true,
          }),
        ],
      }),
    );
    const byKey = Object.fromEntries(
      (await skillsSource(GLOBAL).list(false)).map((f) => [f.key, f]),
    );
    expect(byKey["outline/logo.png"]).toMatchObject({
      mediaType: "image/png",
      blob: { hash: "h-png", size: 9 },
    });
    expect(byKey["outline/data.bin"]?.mediaType).toBeUndefined();
    expect(byKey["outline/data.bin"]?.value).toMatch(/7 bytes/);
    expect(byKey["outline/old.png"]?.blob).toBeUndefined();
    expect(byKey["outline/old.png"]?.value).toMatch(/no longer stored/);
  });

  it("has no empty folders: a folder is there while a file is in it", async () => {
    expect(await skillsSource(GLOBAL).listFolders()).toEqual([]);
  });

  it("opens a file with its versions, skipping versions without it", async () => {
    const s = skill();
    tree(s);
    vi.spyOn(api, "getSkill").mockResolvedValue(detail(s));
    const getFile = vi
      .spyOn(api, "getSkillFile")
      .mockImplementation(async (_id, path, seq) => {
        if (seq === 1) throw new Error("No file");
        return { ...info({ path }), value: seq === 2 ? "v2" : "now" };
      });
    const f = await skillsSource(GLOBAL).get("outline/refs/guide.md");
    expect(f.value).toBe("now");
    expect(f.versions.map((v) => [v.seq, v.value])).toEqual([[2, "v2"]]);
    expect(getFile).toHaveBeenCalledWith("k1", "refs/guide.md", 1);
  });

  it("creates a skill for a top-level folder, and refuses a nested one", async () => {
    const create = vi
      .spyOn(api, "createSkill")
      .mockResolvedValue(detail(skill()));
    const s = skillsSource(GLOBAL);
    await s.createFolder("scene-outline");
    expect(create).toHaveBeenCalledWith(GLOBAL, {
      name: "scene-outline",
      description: NEW_SKILL_DESCRIPTION,
      body: "",
    });
    await expect(s.createFolder("outline/refs")).rejects.toThrow(
      /once it has a file/,
    );
  });

  it("renames a skill for a top-level folder, and moves inside a skill", async () => {
    tree(skill());
    const rename = vi
      .spyOn(api, "renameSkill")
      .mockResolvedValue(detail(skill()));
    const move = vi
      .spyOn(api, "moveSkillPath")
      .mockResolvedValue(detail(skill()));
    const s = skillsSource(GLOBAL);
    await s.renameFolder("outline", "story-outline");
    expect(rename).toHaveBeenCalledWith("k1", "story-outline");
    await s.renameFolder("outline/refs", "outline/notes");
    expect(move).toHaveBeenCalledWith("k1", "refs", "notes");
    await expect(
      s.renameFolder("outline/refs/guide.md", "other/guide.md"),
    ).rejects.toThrow(/inside its skill/);
    await expect(s.renameFolder("outline/refs", "outline")).rejects.toThrow();
  });

  it("deletes a skill for a top-level folder, and a path inside one", async () => {
    tree(skill());
    const del = vi.spyOn(api, "deleteSkill").mockResolvedValue({});
    const delPath = vi
      .spyOn(api, "deleteSkillPath")
      .mockResolvedValue(detail(skill()));
    const s = skillsSource(GLOBAL);
    await s.deleteFolder("outline");
    expect(del).toHaveBeenCalledWith("k1");
    await s.deleteFolder("outline/refs");
    expect(delPath).toHaveBeenCalledWith("k1", "refs");
    await s.remove("outline/refs/guide.md");
    expect(delPath).toHaveBeenLastCalledWith("k1", "refs/guide.md");
  });

  it("saves, restores and uploads inside a skill, and refuses a loose file", async () => {
    const s0 = skill();
    tree(s0);
    vi.spyOn(api, "getSkill").mockResolvedValue(detail(s0));
    vi.spyOn(api, "getSkillFile").mockResolvedValue({ ...info(), value: "x" });
    const put = vi.spyOn(api, "putSkillFile").mockResolvedValue(detail(s0));
    const bytes = vi
      .spyOn(api, "putSkillFileBytes")
      .mockResolvedValue(detail(s0));
    const restore = vi.spyOn(api, "restoreSkill").mockResolvedValue(detail(s0));
    const s = skillsSource(GLOBAL);
    await s.write("outline/SKILL.md", "text/markdown", "new text");
    expect(put).toHaveBeenCalledWith("k1", "SKILL.md", "new text");
    await s.restore("outline/SKILL.md", 1);
    expect(restore).toHaveBeenCalledWith("k1", 1);
    const file = new File(["x"], "logo.bin");
    expect(
      await s.upload(file, "application/octet-stream", "outline/logo.bin"),
    ).toEqual({
      key: "outline/logo.bin",
    });
    expect(bytes).toHaveBeenCalledWith("k1", "logo.bin", file);
    await expect(s.write("loose.md", "text/markdown", "")).rejects.toThrow(
      /inside a skill folder/,
    );
    expect(s.accepts).toEqual({ anyType: true });
  });
});
