import { describe, expect, it } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  NO_AGENTS,
  NO_DATA,
  NO_PROJECTS,
  type AgentSummary,
  type SubagentOutcome,
  type ToolContext,
} from "@harness/core";
import { startSubagent, subagentHandback } from "./subagents.js";

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  id: "a1",
  name: "Editor",
  scope: "global",
  projectName: null,
  description: "Edits.",
  toolMode: "allow",
  tools: [],
  subagent: true,
  builtin: false,
  ...over,
});

function context(
  agents: AgentSummary[],
  outcome: SubagentOutcome,
  canStart = true,
) {
  const started: { agentId: string; task: string; callId: string }[] = [];
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    sessionId: "s",
    runId: "r",
    callId: "c",
    update: () => {},
    state: undefined,
    projectId: null,
    projectName: null,
    projects: NO_PROJECTS,
    agents: { ...NO_AGENTS, list: () => agents },
    subagents: {
      depth: 0,
      canStart,
      start: (input) => {
        started.push(input);
        return Promise.resolve(outcome);
      },
    },
    data: NO_DATA,
    copyLimit: 20,
    skills: [],
    entries: createEntryAccess({
      session: replaySessionEntries([]),
      sessionOps: [],
      inProject: false,
      author: { by: "model", sessionId: "s", runId: "r" },
    }),
    requestInput: () => Promise.resolve({ outcome: "skipped" }),
  };
  return { ctx, started };
}

const ok: SubagentOutcome = { ok: true, agent: "Editor", output: "Fixed." };

describe("start_subagent", () => {
  it("starts a startable agent and returns its output", async () => {
    const { ctx, started } = context([agent()], ok);
    const out = await startSubagent.execute(
      { agentId: "a1", task: "Fix it" },
      ctx,
    );
    expect(started).toEqual([{ agentId: "a1", task: "Fix it", callId: "c" }]);
    expect(out).toEqual({ data: { agent: "Editor", output: "Fixed." } });
  });

  it("refuses an agent that is not marked startable", async () => {
    const { ctx, started } = context([agent({ subagent: false })], ok);
    const out = await startSubagent.execute(
      { agentId: "a1", task: "Fix it" },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(started).toEqual([]);
  });

  it("refuses an unknown agent", async () => {
    const { ctx } = context([agent()], ok);
    const out = await startSubagent.execute(
      { agentId: "nope", task: "x" },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.details).toMatchObject({ reason: "not_found" });
  });

  it("refuses at the depth limit", async () => {
    const { ctx, started } = context([agent()], ok, false);
    const out = await startSubagent.execute({ agentId: "a1", task: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(started).toEqual([]);
  });

  it("turns a failed child into an error with the last text", async () => {
    const { ctx } = context([agent()], {
      ok: false,
      agent: "Editor",
      reason: "iteration_limit",
      message: "Stopped after 5 steps.",
      text: "Half done",
    });
    const out = await startSubagent.execute({ agentId: "a1", task: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.data)).toContain("Half done");
    expect(out.details).toMatchObject({ reason: "iteration_limit" });
  });

  it("asks by default and is not locked", () => {
    expect(startSubagent.approval).toBe("ask");
  });
});

describe("subagent_handback", () => {
  it("hands back its output", async () => {
    const { ctx } = context([], ok);
    const out = await subagentHandback.execute({ output: "Done" }, ctx);
    expect(out.handback).toBe("Done");
    expect(out.isError).toBeUndefined();
  });

  it("refuses an empty output", async () => {
    const { ctx } = context([], ok);
    const out = await subagentHandback.execute({ output: "  " }, ctx);
    expect(out.isError).toBe(true);
    expect(out.handback).toBeUndefined();
  });
});
