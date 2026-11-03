import { z } from "zod";
import {
  defineTool,
  type AgentSummary,
  type CurrentAgent,
  type Form,
} from "@harness/core";
import { fail, notDone } from "./results.js";

/*
 * Agent tools (agent tools design, 3.4). `agents_list` runs without asking;
 * `agent_view` and `agent_change` always ask (they cannot be switched off).
 * A change applies from the next run: the current run keeps its agent
 * (agents design 24).
 */

/** How an agent's scope is written, for the model and the form. */
const scopeText = (a: AgentSummary): string =>
  a.scope === "project" && a.projectName
    ? `project (${a.projectName})`
    : a.scope;

/** An agent as the model sees it. */
const shown = (a: AgentSummary) => ({
  id: a.id,
  name: a.name,
  scope: a.scope,
  ...(a.projectName ? { project: a.projectName } : {}),
  description: a.description,
  toolMode: a.toolMode,
  tools: a.tools,
});

export const agentsList = defineTool({
  name: "agents_list",
  description:
    "Lists the agents this session can pick: the project's agents first, then global ones. Each has an id, name, scope (global, or project with its name), description and the tools it allows or denies. Use an id with agent_change.",
  input: z.object({}),
  approval: "never",
  execute: (_input, ctx) => ({
    data: { agents: ctx.agents.list().map(shown) },
  }),
});

export const agentView = defineTool({
  name: "agent_view",
  description:
    "Shows the agent this run is using: its id, name, scope, version, description, tool selection and system prompt, so you can judge whether the prompt could be improved. Says so when there is no agent. Also says when a change of agent is waiting for the next run. The user must approve each call.",
  input: z.object({}),
  approval: "always",
  execute: (_input, ctx) => {
    const current: CurrentAgent | null = ctx.agents.current();
    const pending = ctx.agents.pending();
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
        ...(pending
          ? {
              pendingChange: {
                appliesFrom: "the next run",
                agent: pending.agent ? shown(pending.agent) : null,
              },
            }
          : {}),
      },
    };
  },
});

/** The form value for "no agent". Only the user can pick it. */
const NO_AGENT = "none";

export const agentChange = defineTool({
  name: "agent_change",
  description:
    "Suggests changing this session's agent to one from agents_list, by id. The user confirms or picks another agent (or no agent) in a form. The change applies from the next run, not this one. You cannot choose no agent. The user must approve each call.",
  input: z.object({
    agentId: z.string().min(1).describe("The id of an agent from agents_list."),
  }),
  approval: "always",
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

export const agentTools = [agentsList, agentView, agentChange];
