import { z } from "zod";
import { defineTool, type SubagentOutcome } from "@harness/core";
import { fail } from "./results.js";

/*
 * Subagent tools (agent delegation design). `start_subagent` waits while a
 * child run of another agent does the task; `subagent_handback` ends a child
 * run and gives its output to the parent. The handback tool is offered only
 * in child runs; `start_subagent` is not offered at the depth limit.
 */

const REASONS: Record<string, string> = {
  failed: "The subagent failed.",
  cancelled: "The subagent was cancelled.",
  iteration_limit: "The subagent hit its iteration limit.",
  no_output: "The subagent handed back nothing.",
};

/** What the parent model sees when a child did not hand back. */
const failure = (o: Extract<SubagentOutcome, { ok: false }>) => ({
  data: {
    error:
      `${REASONS[o.reason] ?? "The subagent did not finish."} ${o.message}`.trim(),
    agent: o.agent,
    ...(o.text ? { lastText: o.text } : {}),
  },
  isError: true,
  details: { reason: o.reason, agent: o.agent },
});

export const startSubagent = defineTool({
  name: "start_subagent",
  description:
    "Hands a task to another agent and waits for its result. Pick an agent from agents_list with subagent: true. The agent does not see this conversation, only the task, so include everything it needs: what is wanted, earlier decisions that matter, and the keys of files it should read or write. Its questions and approvals go to the user. Returns what it hands back.",
  input: z.object({
    agentId: z.string().min(1).describe("The id of an agent from agents_list."),
    task: z
      .string()
      .min(1)
      .describe("The full instructions for the agent: its only context."),
  }),
  approval: "ask",
  execute: async ({ agentId, task }, ctx) => {
    if (!ctx.subagents.canStart) {
      return fail(
        "No more subagents can be started from here: the depth limit is reached.",
        "rejected",
        { agentId },
      );
    }
    const agent = ctx.agents.list().find((a) => a.id === agentId);
    if (!agent) {
      return fail(
        `This session cannot use an agent with the id "${agentId}". Call agents_list.`,
        "not_found",
        { agentId },
      );
    }
    if (!agent.subagent) {
      return fail(
        `${agent.name} is not marked as startable. Pick an agent with subagent: true from agents_list.`,
        "rejected",
        { agentId },
      );
    }
    const outcome = await ctx.subagents.start({
      agentId,
      task,
      callId: ctx.callId,
    });
    if (!outcome.ok) return failure(outcome);
    return { data: { agent: outcome.agent, output: outcome.output } };
  },
});

export const subagentHandback = defineTool({
  name: "subagent_handback",
  description:
    "Ends this task and gives your result to the agent that started you. Call it when you are finished. Put everything the other agent needs in output: it sees nothing else of your work.",
  input: z.object({
    output: z.string().describe("Your result, for the agent that started you."),
  }),
  approval: "never",
  execute: ({ output }) => {
    if (output.trim() === "") {
      return fail(
        "The output is empty. Say what you did or found.",
        "rejected",
      );
    }
    return { data: { handedBack: true }, handback: output };
  },
});

export const subagentTools = [startSubagent, subagentHandback];
