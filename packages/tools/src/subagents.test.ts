import { describe, expect, it } from "vitest";
import {
  createFileAccess,
  replaySessionFiles,
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
  /** The id of the agent the run uses; null: none. */
  currentId: string | null = null,
) {
  const started: {
    agentId: string;
    task: string;
    files?: string[];
    callId: string;
  }[] = [];
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
    agents: {
      ...NO_AGENTS,
      list: () => agents,
      current: () => {
        const own = agents.find((a) => a.id === currentId);
        return own ? { ...own, version: 1, prompt: "" } : null;
      },
    },
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
    files: createFileAccess({
      session: replaySessionFiles([]),
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

  it("attaches image and audio files to the task, and refuses others", async () => {
    const { ctx, started } = context([agent()], ok);
    ctx.files.putBlob("session", "cat.png", "image/png", {
      hash: "h",
      size: 3,
    });
    ctx.files.writeFile("session", "notes.md", "text/markdown", "hi");
    const out = await startSubagent.execute(
      { agentId: "a1", task: "Look", files: ["<session://cat.png>"] },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(started).toEqual([
      {
        agentId: "a1",
        task: "Look",
        files: ["session://cat.png"],
        callId: "c",
      },
    ]);
    for (const files of [["session://gone.png"], ["session://notes.md"]]) {
      const refused = await startSubagent.execute(
        { agentId: "a1", task: "Look", files },
        ctx,
      );
      expect(refused.isError).toBe(true);
    }
    expect(started).toHaveLength(1);
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

  it("refuses to start the agent the run is using", async () => {
    const { ctx, started } = context([agent()], ok, true, "a1");
    const out = await startSubagent.execute(
      { agentId: "a1", task: "Fix it" },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.details).toMatchObject({ reason: "rejected" });
    expect(JSON.stringify(out.data)).toContain("cannot start itself");
    expect(started).toEqual([]);
  });

  it("starts another agent when the run has one of its own", async () => {
    const { ctx, started } = context(
      [agent(), agent({ id: "a2", name: "Critic" })],
      ok,
      true,
      "a1",
    );
    await startSubagent.execute({ agentId: "a2", task: "Review" }, ctx);
    expect(started).toHaveLength(1);
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
