import { z } from "zod";
import {
  defineTool,
  Form,
  type AgentSummary,
  type CurrentAgent,
} from "@harness/core";
import { fail, notDone } from "./results.js";

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

/** The form value for "no agent". Only the user can pick it. */
const NO_AGENT = "none";

/** How an agent's scope is written, for the model and the form. */
const scopeText = (a: AgentSummary): string =>
  a.scope === "project" && a.projectName
    ? `project (${a.projectName})`
    : a.scope;

export const agentChange = defineTool({
  name: "agent_change",
  description: "",
  input: z.object({}),
  approval: "ask",
  group: "agents",
  execute: async ({ agentId }, ctx) => {
    const agents = ctx.agents.list();
    const wanted = agents.find((a) => a.id === agentId);
    if (!wanted) {
      return fail(
        `This session cannot use an agent with the id "${agentId}". Call agents_list.`,
        "not_found",
        { agentId },
      );
    }
    const labels: Record<string, string> = {
      [NO_AGENT]: "No agent",
      ...Object.fromEntries(
        agents.map((a) => [
          a.id,
          `${a.name} (${scopeText(a)})${a.id === wanted.id ? " (suggested)" : ""}`,
        ]),
      ),
    };
    const form: Form = {
      title: "Change the agent?",
      description:
        "The change applies from the next run. This run keeps its current agent.",
      fields: [
        {
          name: "agent",
          label: "Agent",
          required: true,
          noOther: true,
          kind: "choice",
          options: [...agents.map((a) => a.id), NO_AGENT],
          labels,
          default: wanted.id,
        },
      ],
      submitLabel: "Change",
      skipLabel: "Don't change",
    };
    const answer = await ctx.requestInput(form);
    if (answer.outcome === "skipped")
      return notDone("Not changed: the user chose not to change the agent.");
    const picked = String(answer.answers["agent"]);
    const chosen =
      picked === NO_AGENT
        ? null
        : (agents.find((a) => a.id === picked) ?? null);
    ctx.agents.choose(chosen ? chosen.id : null);
    const overrode = picked !== wanted.id;
    return {
      data: {
        agent: chosen ? shown(chosen) : null,
        appliesFrom: "the next run",
        ...(overrode
          ? {
              note: chosen
                ? `The user chose ${chosen.name} instead of your suggestion (${wanted.name}).`
                : `The user chose no agent instead of your suggestion (${wanted.name}).`,
            }
          : {}),
      },
    };
  },
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
        ...(current ? {} : { note: "This run has no agent." }),
      },
    };
  },
});

export const agentTools = [agentsList, agentView];
