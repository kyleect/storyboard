import { describe, expect, it } from "vitest";
import type { CurrentAgent, ToolContext } from "@harness/core";
import {
  DELEGATION_HEADING,
  copyableAgent,
  dataLabel,
  delegationNote,
  withDelegationNote,
} from "./project-copy.js";

const agent = (over: Partial<CurrentAgent> = {}): CurrentAgent => ({
  id: "a1",
  name: "Editor",
  scope: "global",
  projectName: null,
  description: "",
  toolMode: "deny",
  tools: [],
  subagent: false,
  builtin: false,
  version: 1,
  prompt: "",
  ...over,
});

const ctxWith = (current: CurrentAgent | null) =>
  ({
    agents: { list: () => [], current: () => current },
  }) as unknown as ToolContext;

describe("copyableAgent", () => {
  it("is the run's agent", () => {
    expect(copyableAgent(ctxWith(agent()))?.name).toBe("Editor");
  });

  it("is nothing when there is no agent", () => {
    expect(copyableAgent(ctxWith(null))).toBeNull();
  });

  it("is nothing for a built-in agent, which is available everywhere", () => {
    expect(copyableAgent(ctxWith(agent({ builtin: true })))).toBeNull();
  });
});

describe("the delegation note", () => {
  it("names the agent, and speaks to agents that hand work on", () => {
    const note = delegationNote({ name: "Editor" });
    expect(note.startsWith(DELEGATION_HEADING)).toBe(true);
    expect(note).toContain('project agent "Editor"');
    expect(note).toContain("agents_list");
    expect(note).toContain("start_subagent");
    // Every run in the project reads it, the agent's own included.
    expect(note).toContain('If you are "Editor"');
  });

  it("follows what the user wrote, or stands alone", () => {
    expect(withDelegationNote("  Be brief.  ", { name: "Editor" })).toBe(
      `Be brief.\n\n${delegationNote({ name: "Editor" })}`,
    );
    expect(withDelegationNote("", { name: "Editor" })).toBe(
      delegationNote({ name: "Editor" }),
    );
  });
});

describe("dataLabel", () => {
  const plan = (schemas: number, data: number) => ({
    schemas: Array.from({ length: schemas }, () => ({
      fromId: "s",
      name: "n",
      description: "d",
      versions: [],
    })),
    data: Array.from({ length: data }, () => ({
      name: "n",
      description: "d",
      value: 1,
      schemaVersion: 1,
      schema: { keep: "s" },
    })),
    skipped: [],
  });

  it("counts both, singular or plural", () => {
    expect(dataLabel(plan(1, 1))).toBe("1 schema and 1 piece of data");
    expect(dataLabel(plan(2, 5))).toBe("2 schemas and 5 pieces of data");
  });

  it("leaves out what there is none of", () => {
    expect(dataLabel(plan(0, 3))).toBe("3 pieces of data");
    expect(dataLabel(plan(2, 0))).toBe("2 schemas");
  });
});
