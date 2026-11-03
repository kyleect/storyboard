import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentStore } from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import {
  SkillError,
  type Skill,
  type SkillContent,
  type SkillOwner,
  type SkillStore,
} from "./skills-store.js";
import type { Store } from "./store.js";

/*
 * Routes for skills (skills design):
 *
 *   GET    /api/global/skills                 ?deleted=true includes deleted
 *   POST   /api/global/skills                 create
 *   (the same two under /api/projects/:projectId and /api/agents/:agentId)
 *   GET    /api/skills/:id                    with its versions
 *   PUT    /api/skills/:id                    save: a new version
 *   DELETE /api/skills/:id                    soft delete
 *   POST   /api/skills/:id/restore            { seq }
 *
 * Every change is announced on the app-wide stream as `skills.changed`.
 * Skills of a project in the trash, and of a deleted agent, are read-only.
 */

const SkillBody = z.object({
  displayName: z.string(),
  description: z.string(),
  body: z.string(),
});
const ListQuery = z.object({
  deleted: z.enum(["true", "false"]).optional(),
});
const IdParams = z.object({ id: z.string() });
const RestoreBody = z.object({ seq: z.number().int().min(1) });

export function registerSkillRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    agents: AgentStore;
    skills: SkillStore;
    events: AppEvents;
  },
) {
  const { store, agents, skills, events } = deps;

  const announce = (skill: Skill) =>
    events.publish({
      type: "skills.changed",
      data: {
        skillId: skill.id,
        projectId: skill.projectId,
        agentId: skill.agentId,
      },
    });

  /** Throws unless skills can be changed in this owner (decisions 20, 21). */
  const requireWritable = (owner: SkillOwner) => {
    if (owner.scope === "global") return;
    if (owner.scope === "project") {
      const project = store.getProject(owner.id);
      if (!project) throw new SkillError("Project not found.", 404);
      if (project.trashed_at !== null) {
        throw new SkillError("The project is in the trash.", 409);
      }
      return;
    }
    const agent = agents.get(owner.id);
    if (!agent) throw new SkillError("Agent not found.", 404);
    if (agent.deleted) throw new SkillError("The agent is deleted.", 409);
    if (agent.projectId !== null) {
      const project = store.getProject(agent.projectId);
      if (project?.trashed_at) {
        throw new SkillError("The agent's project is in the trash.", 409);
      }
    }
  };

  const skillOf = (req: FastifyRequest): Skill => {
    const { id } = IdParams.parse(req.params);
    const skill = skills.get(id);
    if (!skill) throw new SkillError("Skill not found.", 404);
    return skill;
  };

  const detail = (skill: Skill) => ({
    ...skill,
    versions: skills.versions(skill.id),
  });

  const bases: [string, (req: FastifyRequest) => SkillOwner][] = [
    ["/api/global/skills", () => ({ scope: "global" })],
    [
      "/api/projects/:projectId/skills",
      (req) => {
        const { projectId } = z
          .object({ projectId: z.string() })
          .parse(req.params);
        if (!store.getProject(projectId)) {
          throw new SkillError("Project not found.", 404);
        }
        return { scope: "project", id: projectId };
      },
    ],
    [
      "/api/agents/:agentId/skills",
      (req) => {
        const { agentId } = z.object({ agentId: z.string() }).parse(req.params);
        if (!agents.get(agentId)) throw new SkillError("Agent not found.", 404);
        return { scope: "agent", id: agentId };
      },
    ],
  ];

  for (const [base, ownerOf] of bases) {
    app.get(base, async (req) => {
      const q = ListQuery.parse(req.query);
      return skills.list(ownerOf(req), q.deleted === "true");
    });

    app.post(base, async (req, reply) => {
      const owner = ownerOf(req);
      requireWritable(owner);
      const content: SkillContent = SkillBody.parse(req.body);
      const skill = skills.create(owner, content);
      announce(skill);
      return reply.code(201).send(detail(skill));
    });
  }

  app.get("/api/skills/:id", async (req) => detail(skillOf(req)));

  app.put("/api/skills/:id", async (req) => {
    const current = skillOf(req);
    requireWritable(skills.ownerOf(current));
    const skill = skills.update(current.id, SkillBody.parse(req.body));
    announce(skill);
    return detail(skill);
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const current = skillOf(req);
    requireWritable(skills.ownerOf(current));
    announce(skills.delete(current.id));
    return reply.code(204).send();
  });

  /** Makes an earlier version current; also restores a deleted skill. */
  app.post("/api/skills/:id/restore", async (req) => {
    const current = skillOf(req);
    requireWritable(skills.ownerOf(current));
    const { seq } = RestoreBody.parse(req.body);
    const skill = skills.restore(current.id, seq);
    announce(skill);
    return detail(skill);
  });
}
