import { z } from "zod";
import {
  defineTool,
  type AgentSummary,
  type CurrentAgent,
} from "@harness/core";

/*
 * Agent tools (agent tools design, 3.4). `agents_list` runs without asking;
 * `agent_view` always asks (it cannot be switched off). Handing work to
 * another agent is `start_subagent` (agent delegation design).
 */

/** An agent as the model sees it. */
const shown = (a: AgentSummary) => ({
  id: a.id,
  name: a.name,
  scope: a.scope,
  ...(a.projectName ? { project: a.projectName } : {}),
  description: a.description,
  toolMode: a.toolMode,
  tools: a.tools,
  subagent: a.subagent,
});

export const agentsList = defineTool({
  name: "agents_list",
  description:
    "Lists the other agents that can do work for you: the ones start_subagent can start, project agents first, then global ones. Each has an id, name, scope (global, or project with its name), description, and the tools it allows or denies. Use an id with start_subagent.",
  input: z.object({}),
  approval: "never",
  group: "agents",
  execute: (_input, ctx) => ({
    // Every agent listed is startable, so the flag is left out.
    data: {
      agents: ctx.agents.startable().map((a) => {
        const rest: Partial<ReturnType<typeof shown>> = shown(a);
        delete rest.subagent;
        return rest;
      }),
    },
  }),
});

export const agentView = defineTool({
  name: "agent_view",
  description:
    "Shows the agent this run is using: its id, name, scope, version, description, tool selection and system prompt, so you can judge whether the prompt could be improved. Says so when there is no agent. The user must approve each call.",
  input: z.object({}),
  approval: "always",
  group: "agents",
  execute: (_input, ctx) => {
    const current: CurrentAgent | null = ctx.agents.current();
    return {
      data: {
        agent: current
          ? {
              ...shown(current),
              version: current.version,
              prompt: current.prompt,
            }
          : null,
        ...(current ? {} : { guidance: "This run has no agent." }),
      },
    };
  },
});

export const agentTools = [agentsList, agentView];
