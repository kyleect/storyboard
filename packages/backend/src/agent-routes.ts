import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFromMarkdown, agentToMarkdown } from "./agent-files.js";
import {
  AgentError,
  ToolMode,
  type Agent,
  type AgentContent,
  type AgentStore,
} from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import type { RunManager } from "./runs.js";
import type { Store } from "./store.js";

/*
 * Routes for agents (agents plan 1.2):
 *
 *   GET    /api/global/agents                 ?deleted=true includes deleted
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
  toolMode: ToolMode,
  tools: z.array(z.string()),
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
}

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    runs: RunManager;
    agents: AgentStore;
    events: AppEvents;
  },
) {
  const { store, runs, agents, events } = deps;
  const alwaysOn = new Set(runs.alwaysOnTools);
  const selectable = () => runs.tools.filter((t) => !alwaysOn.has(t.name));

  /** The always-on tools are not part of a selection (decision 8). */
  const clean = (c: AgentContent): AgentContent => ({
    ...c,
    tools: c.tools.filter((t) => !alwaysOn.has(t)),
  });

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

  const detail = (agent: Agent) => ({
    ...agent,
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
      return agents.list(projectId, q.deleted === "true");
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
        runs.tools.map((t) => t.name),
        runs.alwaysOnTools,
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
      .send(agentToMarkdown(agent));
  });

  /**
   * What the session's picker offers: the project's live agents, then the
   * live global agents, each with its scope (decisions 16, 17).
   */
  app.get("/api/sessions/:id/agents", async (req) => {
    const { id } = IdParams.parse(req.params);
    const session = store.getSession(id);
    if (!session) throw new AgentError("Session not found.", 404);
    return agents.pickable(session.project_id).map((a): PickableAgent => ({
      id: a.id,
      name: a.name,
      description: a.description,
      scope: a.projectId === null ? "global" : "project",
    }));
  });

  /** The tools an agent can select: every tool but the always-on ones. */
  app.get("/api/agent-tools", async () =>
    selectable().map((t) => ({ name: t.name, description: t.description })),
  );
}
