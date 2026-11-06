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
import { AgentError, type Agent, type AgentStore } from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import type { DataStore } from "./data-store.js";
import { BUILTIN_DISPATCHER, defaultAgentFor } from "./default-agent.js";
import type { SkillStore } from "./skills-store.js";
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
  /** Left out: a tool cannot send schemas and data to a project. */
  data?: DataStore | undefined;
  /** Left out: a copied agent's own skills are not copied. */
  skills?: SkillStore | undefined;
  agents: AgentStore | undefined;
  events: AppEvents;
  session: SessionRow;
  /**
   * The agent this run started with; null: none. It is the one a tool can
   * copy into a project.
   */
  runAgent?: Agent | null | undefined;
  /** For the default agent rule (global default agent setting). */
  env?: NodeJS.ProcessEnv | undefined;
  /** Who is recorded as the author of entries a tool sends. */
  author: EntryAuthor;
  newId: () => string;
  now: () => string;
  /** Generates note ids. Default: 16 random hex digits. */
  newNoteId?: (() => string) | undefined;
}

const randomNoteId = () => randomBytes(8).toString("hex");
const randomId = () => randomBytes(8).toString("hex");

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
      /** The project's own schemas and data. Nothing else is reached. */
      const shared = () => {
        if (!deps.data) {
          throw new EntryError(
            "Sending schemas and data to a project is not available.",
          );
        }
        return deps.data.shared({ projectId, agentId: null });
      };
      /**
       * An agent's own skills, schemas and data go to its copy. The source is
       * the original's scopes (its project, if it had one), the destination
       * the copy's. A schema the data needs that is neither global nor
       * built-in is copied into the copy's agent scope.
       */
      const copyAgentBelongings = (from: Agent, to: Agent) => {
        let skills = 0;
        let schemas = 0;
        let data = 0;
        if (deps.skills) {
          for (const s of deps.skills.list({ scope: "agent", id: from.id })) {
            deps.skills.create(
              { scope: "agent", id: to.id },
              {
                displayName: s.displayName,
                description: s.description,
                body: s.body,
              },
            );
            skills++;
          }
        }
        if (deps.data) {
          const source = deps.data.shared({
            projectId: from.projectId,
            agentId: from.id,
          });
          const dest = deps.data.shared({ projectId, agentId: to.id });
          const ids = new Map<string, string>();
          const copySchema = (id: string): string | undefined => {
            const known = ids.get(id);
            if (known) return known;
            const schema = source.getSchema(id);
            if (!schema || schema.deleted) return undefined;
            const newId = randomId();
            const [first, ...later] = Array.from(
              { length: schema.version },
              (_, i) => source.schemaBody(id, i + 1),
            );
            dest.createSchema(
              "agent",
              {
                id: newId,
                name: schema.name,
                description: schema.description,
                copiedFrom: null,
              },
              first,
            );
            for (const body of later) dest.addSchemaVersion(newId, body);
            ids.set(id, newId);
            schemas++;
            return newId;
          };
          for (const s of source.listSchemas("agent")) copySchema(s.id);
          for (const d of source.listData("agent")) {
            const schema = source.getSchema(d.schemaId);
            const keeps =
              schema?.scope === "global" || schema?.scope === "builtin";
            const schemaId = keeps ? d.schemaId : copySchema(d.schemaId);
            if (schemaId === undefined) continue;
            dest.putData(
              "agent",
              {
                id: randomId(),
                schemaId,
                schemaVersion: d.schemaVersion,
                name: d.name,
                description: d.description,
                value: d.value,
              },
              deps.author,
            );
            data++;
          }
        }
        return { skills, schemas, data };
      };
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
        putSchema: ({ name, description, copiedFrom, versions }) => {
          const [first, ...later] = versions;
          if (first === undefined) {
            throw new EntryError(`The schema "${name}" has no version.`);
          }
          const data = shared();
          if (data.nameTaken("project", name)) {
            throw new EntryError(
              `The project already has a schema named "${name}".`,
            );
          }
          const id = randomId();
          data.createSchema(
            "project",
            { id, name, description, copiedFrom },
            first,
          );
          for (const body of later) data.addSchemaVersion(id, body);
          return id;
        },
        putData: ({ schemaId, schemaVersion, name, description, value }) => {
          const data = shared();
          const schema = data.getSchema(schemaId);
          if (!schema || schema.deleted) {
            throw new EntryError(
              `The project cannot use the schema "${schemaId}" for "${name}".`,
            );
          }
          const id = randomId();
          data.putData(
            "project",
            { id, schemaId, schemaVersion, name, description, value },
            deps.author,
          );
          return id;
        },
        putAgent: () => {
          const agent = deps.runAgent;
          if (!agent)
            throw new EntryError("This session has no agent to copy.");
          if (agent.builtin) {
            throw new EntryError(
              `The agent "${agent.name}" is built in and available everywhere, so there is nothing to copy.`,
            );
          }
          if (!deps.agents) {
            throw new EntryError("Copying an agent is not available.");
          }
          try {
            // Startable whatever the original was: the Dispatcher can only
            // start agents marked as subagents (agent delegation design 26).
            const copy = deps.agents.create(projectId, {
              name: agent.name,
              description: agent.description,
              prompt: agent.prompt,
              toolGrant: agent.toolGrant,
              toolApproval: agent.toolApproval,
              childReminders: agent.childReminders,
              childPrompt: agent.childPrompt,
              subagent: true,
            });
            deps.events.publish({
              type: "agents.changed",
              data: { agentId: copy.id, projectId, clearedSessions: [] },
            });
            const copied = copyAgentBelongings(agent, copy);
            return { id: copy.id, name: copy.name, ...copied };
          } catch (err) {
            if (err instanceof AgentError) throw new EntryError(err.message);
            throw err;
          }
        },
        useDispatcher: () => {
          const agents = deps.agents;
          const dispatcher = agents?.get(BUILTIN_DISPATCHER);
          if (
            !agents ||
            !dispatcher ||
            !agents.usableIn(dispatcher, projectId)
          ) {
            return false;
          }
          // The same rule a new session follows: project, global, Dispatcher.
          const starts = defaultAgentFor(
            { store, agents, env: deps.env },
            projectId,
          );
          if (starts?.id === BUILTIN_DISPATCHER) return false;
          store.updateProject(projectId, {
            defaultAgentId: BUILTIN_DISPATCHER,
          });
          return true;
        },
        setSystemPrompt: (text) => {
          store.updateProject(projectId, { systemPrompt: text });
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
