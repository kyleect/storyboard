import { describe, expect, it } from "vitest";
import {
  createFileAccess,
  NO_AGENTS,
  NO_SUBAGENTS,
  NO_DATA,
  NO_PROJECTS,
  NO_SKILL_FILES,
  replaySessionFiles,
  type RunSkill,
  type SkillFileAccess,
  type ToolContext,
} from "@harness/core";
import { skillLoad, skillsList } from "./skills.js";

const skill = (over: Partial<RunSkill> = {}): RunSkill => ({
  id: "k1",
  name: "dialogue-polish",
  description: "Use when revising dialogue so it sounds natural.",
  instructions: "Read each line aloud.\nCut the filler.",
  scope: "global",
  version: 1,
  files: [{ path: "SKILL.md", mediaType: "text/markdown", size: 80 }],
  ...over,
});

const ctx = (
  skills: RunSkill[],
  skillFiles: SkillFileAccess = NO_SKILL_FILES,
): ToolContext => ({
  signal: new AbortController().signal,
  sessionId: "s",
  runId: "r",
  callId: "c",
  update: () => {},
  requestInput: () => Promise.reject(new Error("Not used here.")),
  state: undefined,
  projectId: null,
  projectName: null,
  skills,
  skillFiles,
  projects: NO_PROJECTS,
  agents: NO_AGENTS,
  subagents: NO_SUBAGENTS,
  data: NO_DATA,
  copyLimit: 20,
  files: createFileAccess({
    session: replaySessionFiles([]),
    sessionOps: [],
    inProject: false,
    author: { by: "model", sessionId: "s", runId: "r" },
  }),
});

describe("skillsList", () => {
  it("is empty when no skill is in scope", () => {
    expect(skillsList([])).toBe("");
  });

  it("lists each skill with its description on one line", () => {
    const text = skillsList([
      skill(),
      skill({
        name: "scene-outline",
        description: "Use when breaking a scene\ninto   beats.",
        scope: "project",
      }),
    ]);
    expect(text).toBe(
      [
        "- dialogue-polish: Use when revising dialogue so it sounds natural.",
        "- scene-outline: Use when breaking a scene into beats.",
      ].join("\n"),
    );
  });

  it("shows the scope only for a name that is in more than one scope", () => {
    const text = skillsList([
      skill(),
      skill({ scope: "project", description: "The project's own take." }),
      skill({ name: "other", scope: "agent", description: "Another." }),
    ]);
    expect(text).toContain("- dialogue-polish (global): Use when revising");
    expect(text).toContain("- dialogue-polish (project): The project's own");
    expect(text).toContain("- other: Another.");
  });
});

describe("skill_load", () => {
  it("returns the body as the result, and does not ask", async () => {
    expect(skillLoad.approval).toBe("never");
    expect(
      await skillLoad.execute({ name: "dialogue-polish" }, ctx([skill()])),
    ).toEqual({
      data: "Read each line aloud.\nCut the filler.",
    });
  });

  it("checks its arguments", () => {
    expect(skillLoad.parse({ name: "x" })).toEqual({
      ok: true,
      input: { name: "x" },
    });
    expect(skillLoad.parse({ name: "x", scope: "project" }).ok).toBe(true);
    expect(skillLoad.parse({ name: "x", scope: "session" }).ok).toBe(false);
    expect(skillLoad.parse({}).ok).toBe(false);
  });

  it("says what is available when the name is unknown", async () => {
    const out = await skillLoad.execute({ name: "nope" }, ctx([skill()]));
    expect(out).toMatchObject({ isError: true });
    expect(out.data).toContain('No skill named "nope"');
    expect(out.data).toContain("dialogue-polish");
  });

  it("needs the scope when a name is in two scopes", async () => {
    const skills = [
      skill({ instructions: "GLOBAL" }),
      skill({ scope: "project", instructions: "PROJECT" }),
    ];
    const clash = await skillLoad.execute(
      { name: "dialogue-polish" },
      ctx(skills),
    );
    expect(clash).toMatchObject({ isError: true });
    expect(clash.data).toContain("global, project");
    expect(
      await skillLoad.execute(
        { name: "dialogue-polish", scope: "project" },
        ctx(skills),
      ),
    ).toEqual({ data: "PROJECT" });
  });

  it("says where a skill is defined when the scope given is wrong", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", scope: "agent" },
      ctx([skill()]),
    );
    expect(out).toMatchObject({ isError: true });
    expect(out.data).toContain("defined in: global");
  });

  it("says so when a skill has no instructions", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish" },
      ctx([skill({ instructions: "  " })]),
    );
    expect(out).toEqual({
      data: 'The skill "dialogue-polish" has no instructions.',
    });
  });

  it("lists the other files in the folder after the instructions", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish" },
      ctx([
        skill({
          files: [
            { path: "SKILL.md", mediaType: "text/markdown", size: 80 },
            {
              path: "references/tone.md",
              mediaType: "text/markdown",
              size: 12,
            },
            { path: "assets/logo.png", mediaType: "image/png", size: 340 },
          ],
        }),
      ]),
    );
    expect(out.data).toBe(
      [
        "Read each line aloud.",
        "Cut the filler.",
        "",
        "Other files in this skill (read one with path):",
        "- references/tone.md (text/markdown, 12 bytes)",
        "- assets/logo.png (image/png, 340 bytes)",
      ].join("\n"),
    );
  });

  it("checks path, offset and limit", () => {
    expect(
      skillLoad.parse({ name: "x", path: "a.md", offset: 5, limit: 10 }).ok,
    ).toBe(true);
    expect(skillLoad.parse({ name: "x", path: "" }).ok).toBe(false);
    expect(skillLoad.parse({ name: "x", path: "a", limit: 0 }).ok).toBe(false);
    expect(skillLoad.parse({ name: "x", path: "a", limit: 20_001 }).ok).toBe(
      false,
    );
  });
});

describe("skill_load with a path", () => {
  const files = (
    read: Record<string, ReturnType<SkillFileAccess["read"]>>,
  ): SkillFileAccess => ({ read: (_s, path) => read[path] });
  const withFiles = (
    read: Record<string, ReturnType<SkillFileAccess["read"]>>,
  ) =>
    ctx(
      [
        skill({
          files: [
            { path: "SKILL.md", mediaType: "text/markdown", size: 80 },
            { path: "a.md", mediaType: "text/markdown", size: 11 },
          ],
        }),
      ],
      files(read),
    );

  it("returns the text of a file", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", path: "a.md" },
      withFiles({
        "a.md": {
          kind: "text",
          mediaType: "text/markdown",
          size: 11,
          text: "hello there",
        },
      }),
    );
    expect(out.data).toEqual({
      path: "a.md",
      mediaType: "text/markdown",
      totalCharacters: 11,
      offset: 0,
      text: "hello there",
    });
  });

  it("reads on with offset and limit, and says where to continue", async () => {
    const c = withFiles({
      "a.md": {
        kind: "text",
        mediaType: "text/markdown",
        size: 11,
        text: "hello there",
      },
    });
    const first = await skillLoad.execute(
      { name: "dialogue-polish", path: "a.md", limit: 5 },
      c,
    );
    expect(first.data).toMatchObject({ text: "hello" });
    expect((first.data as { guidance: string }).guidance).toContain("offset 5");
    const rest = await skillLoad.execute(
      { name: "dialogue-polish", path: "a.md", offset: 5 },
      c,
    );
    expect(rest.data).toMatchObject({ offset: 5, text: " there" });
    expect(rest.data).not.toHaveProperty("guidance");
  });

  it("accepts a path written with a leading ./", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", path: "./a.md" },
      withFiles({
        "a.md": {
          kind: "text",
          mediaType: "text/markdown",
          size: 1,
          text: "x",
        },
      }),
    );
    expect(out.data).toMatchObject({ path: "a.md", text: "x" });
  });

  it("says a binary file has no text", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", path: "a.md" },
      withFiles({
        "a.md": { kind: "binary", mediaType: "application/zip", size: 9 },
      }),
    );
    expect(out.data).toMatchObject({
      mediaType: "application/zip",
      guidance: "This is a binary file, so there is no text to read.",
    });
  });

  it("says when the bytes of a file were pruned", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", path: "a.md" },
      withFiles({
        "a.md": { kind: "missing", mediaType: "image/png", size: 9 },
      }),
    );
    expect(out).toMatchObject({ isError: true });
  });

  it("lists the files when the path is not in the folder", async () => {
    const out = await skillLoad.execute(
      { name: "dialogue-polish", path: "nope.md" },
      withFiles({}),
    );
    expect(out).toMatchObject({ isError: true });
    expect(out.data).toContain("SKILL.md, a.md");
  });
});
