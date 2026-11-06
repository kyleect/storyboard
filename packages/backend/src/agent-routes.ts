import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFromMarkdown, agentToMarkdown } from "./agent-files.js";
import {
  AgentError,
  type Agent,
  type AgentContent,
  type AgentStore,
} from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import { defaultAgentFor } from "./default-agent.js";
import type { RunManager } from "./runs.js";
import type { Store } from "./store.js";
import { newToolNames, ToolGrant } from "./tool-grants.js";
import { alwaysAsks, listToolSettings, offNames } from "./tool-settings.js";

/*
 * Routes for agents (agents plan 1.2):
 *
 *   GET    /api/global/agents                 ?deleted=true includes deleted;
 *                                             the built-in agents come last
 *   POST   /api/global/agents                 create
 *   POST   /api/global/agents/import          { markdown, replace? }
 *   (the same three under /api/projects/:projectId)
 *   GET    /api/agents/:id                    with its versions
 *   PUT    /api/agents/:id                    save: a new version
 *   DELETE /api/agents/:id                    soft delete
 *   POST   /api/agents/:id/restore            { seq }
 *   GET    /api/agents/:id/versions/:seq
 *   GET    /api/agents/:id/export             text/markdown
 *   GET    /api/sessions/:id/agents           what the session can pick
 *   GET    /api/agent-tools                   the tools an agent can select
 *
 * Every change is announced on the app-wide stream as `agents.changed`.
 * Agents of a project in the trash are read-only.
 */

const AgentBody = z.object({
  name: z.string(),
  description: z.string().default(""),
  prompt: z.string(),
  toolGrant: ToolGrant,
  toolApproval: z.record(z.string(), z.boolean()).default({}),
  childReminders: z.number().int().min(0).nullable().default(null),
  childPrompt: z.string().nullable().default(null),
  subagent: z.boolean().default(false),
});
const ListQuery = z.object({
  deleted: z.enum(["true", "false"]).optional(),
});
const IdParams = z.object({ id: z.string() });
const ImportBody = z.object({
  markdown: z.string(),
  replace: z.boolean().optional(),
});
const RestoreBody = z.object({ seq: z.number().int().min(1) });

/** The name with characters file systems refuse replaced by "_". */
function safeFileName(name: string): string {
  return [...name]
    .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("");
}

/** An agent in a picker, with its scope (decision 17). */
export interface PickableAgent {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global";
  /** The session's project's default agent (default agent design 6). */
  isDefault: boolean;
  /** A built-in agent (read-only). */
  builtin: boolean;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    runs: RunManager;
    agents: AgentStore;
    events: AppEvents;
    env?: NodeJS.ProcessEnv | undefined;
  },
) {
  const { store, runs, agents, events } = deps;
  const fixed = new Set(runs.tools.filter(alwaysAsks).map((t) => t.name));

  /**
   * The always-on tools are not part of a selection (decision 8; design,
   * decision 14), so they are left out of the grant's exceptions and extras.
   * A tool that always asks has no setting of the agent's (agent tool
   * approval design, Q2). Names with no such tool are kept. A save records
   * the tools that exist now as the ones the agent knows (design, decisions
   * 9, 10).
   */
  const clean = (c: AgentContent): AgentContent => {
    const alwaysOn = runs.alwaysOnTools();
    return {
      ...c,
      toolGrant: {
        ...c.toolGrant,
        except: c.toolGrant.except.filter((t) => !alwaysOn.has(t)),
        extras: c.toolGrant.extras.filter((t) => !alwaysOn.has(t)),
        known: runs.tools.map((t) => t.name),
      },
      toolApproval: Object.fromEntries(
        Object.entries(c.toolApproval).filter(([name]) => !fixed.has(name)),
      ),
    };
  };

  const announce = (agent: Agent, clearedSessions: string[] = []) =>
    events.publish({
      type: "agents.changed",
      data: { agentId: agent.id, projectId: agent.projectId, clearedSessions },
    });

  const requireWritableScope = (projectId: string | null) => {
    if (projectId === null) return;
    const project = store.getProject(projectId);
    if (!project) throw new AgentError("Project not found.", 404);
    if (project.trashed_at !== null) {
      throw new AgentError("The project is in the trash.", 409);
    }
  };

  const agentOf = (req: FastifyRequest): Agent => {
    const { id } = IdParams.parse(req.params);
    const agent = agents.get(id);
    if (!agent) throw new AgentError("Agent not found.", 404);
    return agent;
  };

  /**
   * The tools that exist now but were not there when the agent was last
   * saved (design, decision 9). A built-in agent never has any (decision 16).
   */
  const withNew = (agent: Agent) => ({
    ...agent,
    newTools: agent.builtin ? [] : newToolNames(agent.toolGrant, runs.tools),
  });

  const detail = (agent: Agent) => ({
    ...withNew(agent),
    versions: agents.versions(agent.id),
  });

  const bases: [string, (req: FastifyRequest) => string | null][] = [
    ["/api/global/agents", () => null],
    [
      "/api/projects/:projectId/agents",
      (req) => {
        const { projectId } = z
          .object({ projectId: z.string() })
          .parse(req.params);
        if (!store.getProject(projectId)) {
          throw new AgentError("Project not found.", 404);
        }
        return projectId;
      },
    ],
  ];

  for (const [base, scopeOf] of bases) {
    app.get(base, async (req) => {
      const projectId = scopeOf(req);
      const q = ListQuery.parse(req.query);
      const list = [
        ...agents.list(projectId, q.deleted === "true"),
        ...(projectId === null ? agents.builtins() : []),
      ];
      // A list marks the agent a new session in its scope starts with:
      // the project's default, else the global one (default agent design 6;
      // global default agent design, Q9).
      const defaultId = defaultAgentFor(deps, projectId)?.id;
      return list.map((a) => ({
        ...withNew(a),
        isDefault: a.id === defaultId,
      }));
    });

    app.post(base, async (req, reply) => {
      const projectId = scopeOf(req);
      requireWritableScope(projectId);
      const agent = agents.create(projectId, clean(AgentBody.parse(req.body)));
      announce(agent);
      return reply.code(201).send(detail(agent));
    });

    /**
     * Imports one agent file (decisions 26 to 29). A name already in the
     * scope: 409 with the existing agent's id, unless `replace` is set, in
     * which case the file becomes that agent's next version (it is also
     * restored if it was deleted).
     */
    app.post(`${base}/import`, async (req, reply) => {
      const projectId = scopeOf(req);
      requireWritableScope(projectId);
      const body = ImportBody.parse(req.body);
      const parsed = agentFromMarkdown(
        body.markdown,
        runs.tools,
        runs.alwaysOnTools(),
        [...fixed],
      );
      const existing = agents.getByName(projectId, parsed.content.name);
      if (existing && !body.replace) {
        return reply.code(409).send({
          error: `An agent named "${existing.name}" already exists here.`,
          conflict: { agentId: existing.id, deleted: existing.deleted },
        });
      }
      const agent = existing
        ? agents.replace(existing.id, parsed.content)
        : agents.create(projectId, parsed.content);
      announce(agent);
      return reply
        .code(existing ? 200 : 201)
        .send({ agent: detail(agent), warnings: parsed.warnings });
    });
  }

  app.get("/api/agents/:id", async (req) => detail(agentOf(req)));

  app.put("/api/agents/:id", async (req) => {
    const current = agentOf(req);
    requireWritableScope(current.projectId);
    const agent = agents.update(current.id, clean(AgentBody.parse(req.body)));
    announce(agent);
    return detail(agent);
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const current = agentOf(req);
    requireWritableScope(current.projectId);
    const { agent, sessions } = agents.delete(current.id);
    announce(agent, sessions);
    return reply.code(204).send();
  });

  /** Makes an earlier version current; also restores a deleted agent. */
  app.post("/api/agents/:id/restore", async (req) => {
    const current = agentOf(req);
    requireWritableScope(current.projectId);
    const { seq } = RestoreBody.parse(req.body);
    const agent = agents.restore(current.id, seq);
    announce(agent);
    return detail(agent);
  });

  /** One version, for the agent label on a message (decision 15). */
  app.get("/api/agents/:id/versions/:seq", async (req) => {
    const agent = agentOf(req);
    const { seq } = z
      .object({ seq: z.coerce.number().int().min(1) })
      .parse(req.params);
    const version = agents.version(agent.id, seq);
    if (!version) throw new AgentError(`No version ${seq}.`, 404);
    return { agentId: agent.id, projectId: agent.projectId, ...version };
  });

  /** The current version as one Markdown file (decisions 26, 27, 36). */
  app.get("/api/agents/:id/export", async (req, reply) => {
    const agent = agentOf(req);
    const filename = `${safeFileName(agent.name)}.md`;
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(agentToMarkdown(agent, runs.tools, runs.alwaysOnTools()));
  });

  /**
   * What the session's picker offers: the project's live agents, then the
   * live global agents, each with its scope (decisions 16, 17).
   */
  app.get("/api/sessions/:id/agents", async (req) => {
    const { id } = IdParams.parse(req.params);
    const session = store.getSession(id);
    if (!session) throw new AgentError("Session not found.", 404);
    const defaultId = defaultAgentFor(deps, session.project_id)?.id;
    return agents.pickable(session.project_id).map((a): PickableAgent => ({
      id: a.id,
      name: a.name,
      description: a.description,
      scope: a.projectId === null ? "global" : "project",
      isDefault: a.id === defaultId,
      builtin: a.builtin,
    }));
  });

  /**
   * Every tool with whether it is always on and its setting now, for the
   * editor's approval choices (agent tool approval design, Q3, Q5).
   */
  app.get("/api/agent-tool-approvals", async () =>
    listToolSettings(store.db, runs.tools).map((t) => ({
      name: t.name,
      description: t.description,
      group: t.group,
      alwaysOn: t.alwaysOn,
      ask: t.ask,
      fixed: t.fixed,
    })),
  );

  /**
   * Every tool, for the agent editor (tool management design, decisions 2,
   * 14): its group, whether it is always on now (shown locked), whether it is
   * off for the whole harness, and whether it needs review.
   */
  app.get("/api/agent-tools", async () => {
    const alwaysOn = runs.alwaysOnTools();
    const off = offNames(store.db);
    return runs.tools.map((t) => ({
      name: t.name,
      description: t.description,
      group: t.group,
      alwaysOn: alwaysOn.has(t.name),
      off: off.has(t.name),
      needsReview: t.needsReview,
    }));
  });
}
