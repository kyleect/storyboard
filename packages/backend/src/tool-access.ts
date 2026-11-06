import { randomBytes } from "node:crypto";
import {
  checkFileKey,
  checkFileValue,
  EntryError,
  type AgentAccess,
  type AgentSummary,
  type EntryAuthor,
  type ProjectAccess,
  type ProjectPush,
} from "@harness/core";
import type { Agent, AgentStore } from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import type { EntryStore } from "./entries-store.js";
import type { SessionRow, Store } from "./store.js";
import { listedTools, type GrantTool } from "./tool-grants.js";

/*
 * What the project and agent tools reach through their context (agent tools
 * design, section 3; plan 2.3). Core defines the interfaces; these implement
 * them for one session and run.
 */

export interface ProjectAccessDeps {
  store: Store;
  /** Left out: a tool cannot send entries to a project. */
  entries: EntryStore | undefined;
  agents: AgentStore | undefined;
  events: AppEvents;
  session: SessionRow;
  /** Who is recorded as the author of entries a tool sends. */
  author: EntryAuthor;
  newId: () => string;
  now: () => string;
  /** Generates note ids. Default: 16 random hex digits. */
  newNoteId?: (() => string) | undefined;
}

const randomNoteId = () => randomBytes(8).toString("hex");

export function projectAccess(deps: ProjectAccessDeps): ProjectAccess {
  const { store, entries, session } = deps;
  return {
    list: () =>
      store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, description: p.description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    current: () => {
      const project = session.project_id
        ? store.getProject(session.project_id)
        : undefined;
      if (!project) return null;
      const defaultAgent = project.default_agent_id
        ? deps.agents?.get(project.default_agent_id)
        : undefined;
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        defaultAgent: defaultAgent ? defaultAgent.name : null,
        systemPrompt: project.system_prompt,
      };
    },
    create: ({ name, description, systemPrompt }) => {
      const project = store.createProject({
        id: deps.newId(),
        name,
        description,
        now: deps.now(),
      });
      if (systemPrompt !== "") {
        store.updateProject(project.id, { systemPrompt });
      }
      deps.events.publish({
        type: "projects.changed",
        data: { projectId: project.id },
      });
      return {
        id: project.id,
        name: project.name,
        description: project.description,
      };
    },
    push: (projectId): ProjectPush => {
      const project = store.getProject(projectId);
      if (!project) throw new EntryError(`There is no project "${projectId}".`);
      if (project.trashed_at !== null) {
        throw new EntryError(`The project "${project.name}" is in the trash.`);
      }
      if (!entries) {
        throw new EntryError("Sending entries to a project is not available.");
      }
      const newNoteId = deps.newNoteId ?? randomNoteId;
      return {
        hasFile: (key) => {
          const row = entries.get("file", projectId, key);
          return row !== undefined && row.deleted_at === null;
        },
        putFile: (key, type, value) => {
          checkFileKey(key);
          checkFileValue(type, value);
          entries.put("file", projectId, { key, value, type }, deps.author);
        },
        addNote: (text) => {
          let id = newNoteId();
          for (let i = 0; entries.get("note", projectId, id); i++) {
            if (i >= 100) throw new EntryError("Could not generate a note id.");
            id = newNoteId();
          }
          entries.put("note", projectId, { key: id, value: text }, deps.author);
          return id;
        },
      };
    },
  };
}

export interface AgentAccessDeps {
  store: Store;
  agents: AgentStore | undefined;
  session: SessionRow;
  /** The agent this run started with; null: none. */
  runAgent: Agent | null;
  /** Every tool, to show an agent's grant as a list of names. */
  tools: readonly GrantTool[];
}

export function agentAccess(deps: AgentAccessDeps): AgentAccess {
  const { store, agents, session } = deps;
  const summary = (a: Agent): AgentSummary => ({
    id: a.id,
    name: a.name,
    scope: a.projectId === null ? "global" : "project",
    projectName:
      a.projectId === null
        ? null
        : (store.getProject(a.projectId)?.name ?? null),
    description: a.description,
    ...listedTools(a.toolGrant, deps.tools),
    subagent: a.subagent,
    builtin: a.builtin,
  });
  return {
    list: () =>
      agents ? agents.pickable(session.project_id).map(summary) : [],
    current: () =>
      deps.runAgent
        ? {
            ...summary(deps.runAgent),
            version: deps.runAgent.version,
            prompt: deps.runAgent.prompt,
          }
        : null,
  };
}
