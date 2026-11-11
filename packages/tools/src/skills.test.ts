import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  NO_AGENTS,
  NO_SUBAGENTS,
  NO_DATA,
  NO_PROJECTS,
  replaySessionEntries,
  type RunSkill,
  type ToolContext,
} from "@harness/core";
import { skillLoad, skillsList } from "./skills.js";

const skill = (over: Partial<RunSkill> = {}): RunSkill => ({
  name: "dialogue-polish",
  displayName: "Dialogue Polish",
  description: "Use when revising dialogue so it sounds natural.",
  body: "Read each line aloud.\nCut the filler.",
  scope: "global",
  ...over,
});

const ctx = (skills: RunSkill[]): ToolContext => ({
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
  projects: NO_PROJECTS,
  agents: NO_AGENTS,
  subagents: NO_SUBAGENTS,
  data: NO_DATA,
  copyLimit: 20,
  entries: createEntryAccess({
    session: replaySessionEntries([]),
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
        displayName: "Scene Outline",
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
      skill({ body: "GLOBAL" }),
      skill({ scope: "project", body: "PROJECT" }),
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
      ctx([skill({ body: "  " })]),
    );
    expect(out).toEqual({
      data: 'The skill "dialogue-polish" has no instructions.',
    });
  });
});
