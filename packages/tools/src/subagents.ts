import { z } from "zod";
import {
  defineTool,
  mediaKindOf,
  parseRef,
  plainRef,
  type SubagentOutcome,
} from "@harness/core";
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
    "Hands a task to another agent and waits for its result. Pick an agent from agents_list. The agent does not see this conversation, only the task, so include everything it needs: what is wanted, earlier decisions that matter, and the keys of files it should read or write. Its questions and approvals go to the user. Returns what it hands back.",
  input: z.object({
    agentId: z.string().min(1).describe("The id of an agent from agents_list."),
    task: z
      .string()
      .min(1)
      .describe("The full instructions for the agent: its only context."),
    files: z
      .array(z.string().min(1))
      .max(8)
      .optional()
      .describe(
        "Images or audio files the agent should look at, as references such as <session://cat.png>. It sees them with the task.",
      ),
  }),
  approval: "ask",
  group: "subagents",
  available: (run) => run.canStartSubagent,
  execute: async ({ agentId, task, files }, ctx) => {
    if (!ctx.subagents.canStart) {
      return fail(
        "No more subagents can be started from here: the depth limit is reached.",
        "rejected",
        { agentId },
      );
    }
    if (agentId === ctx.agents.current()?.id) {
      return fail(
        "An agent cannot start itself. Pick another agent from agents_list.",
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
        `${agent.name} is not marked as startable. Pick an agent from agents_list.`,
        "rejected",
        { agentId },
      );
    }
    const refs: string[] = [];
    for (const given of files ?? []) {
      const ref = parseRef(given.trim());
      const found =
        ref &&
        ref.location !== "workspace" &&
        ctx.files.scopes.includes(ref.location)
          ? ctx.files.readFile(ref.location, ref.path)
          : undefined;
      if (!ref || ref.location === "workspace" || !found) {
        return fail(`There is no file ${given} to attach.`, "not_found", {
          agentId,
          file: given,
        });
      }
      if (!found.blob || !found.mediaType || !mediaKindOf(found.mediaType)) {
        return fail(
          `${given} is not an image or audio file, so it cannot be attached. Name text files in the task instead.`,
          "rejected",
          { agentId, file: given },
        );
      }
      refs.push(plainRef(ref));
    }
    const outcome = await ctx.subagents.start({
      agentId,
      task,
      ...(refs.length > 0 ? { files: refs } : {}),
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
  group: "subagents",
  alwaysOn: true,
  available: (run) => run.isChild,
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
