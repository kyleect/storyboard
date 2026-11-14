import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentStore } from "./agents-store.js";
import type { AppEvents } from "./app-events.js";
import {
  instructionsOf,
  parseSkillFile,
  renameInSkillFile,
  skillNameProblem,
} from "./skill-frontmatter.js";
import { readSkillZip, writeSkillZip } from "./skill-zip.js";
import {
  DEFAULT_SKILL_LIMITS,
  isTextType,
  SKILL_FILE,
  SkillError,
  type Skill,
  type SkillOwner,
  type SkillStore,
} from "./skills-store.js";
import type { Store } from "./store.js";

/*
 * Routes for skills (skills design; skills folders design). A skill is a
 * folder; the routes that take a path work on one file in it.
 *
 *   GET    /api/global/skills                 ?deleted=true includes deleted;
 *                                             ?files=true adds each skill's files
 *   POST   /api/global/skills                 create a skill with a SKILL.md
 *                                             made from { name, description, body }
 *   POST   /api/global/skills/copy            { id }: a copy of that skill here
 *   POST   /api/global/skills/import/preview  a zip: what importing it would do
 *   POST   /api/global/skills/import          a zip; ?resolve=replace or
 *                                             ?resolve=rename&name=new-name
 *                                             when the name is taken
 *   (the same under /api/projects/:projectId and /api/agents/:agentId)
 *   GET    /api/skills/:id                    with its files and versions
 *   PUT    /api/skills/:id                    save { description, body }: SKILL.md
 *   DELETE /api/skills/:id                    soft delete
 *   POST   /api/skills/:id/restore            { seq }
 *   POST   /api/skills/:id/rename             { name }: the folder and SKILL.md's name
 *   GET    /api/skills/:id/export             ?seq=  a zip of the folder
 *   GET    /api/skills/:id/file               ?path=&seq=  one file as JSON
 *   PUT    /api/skills/:id/file               ?path=  { value }: a text file
 *   DELETE /api/skills/:id/file               ?path=  a file, or a folder and all in it
 *   GET    /api/skills/:id/file/raw           ?path=&seq=  the bytes
 *   PUT    /api/skills/:id/file/raw           ?path=  the bytes of a file
 *   POST   /api/skills/:id/move               { from, to }: a file or folder
 *
 * Every change is announced on the app-wide stream as `skills.changed`.
 * Skills of a project in the trash, and of a deleted agent, are read-only.
 */

const SkillBody = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
});
const TextBody = z.object({ description: z.string(), body: z.string() });
const ListQuery = z.object({
  deleted: z.enum(["true", "false"]).optional(),
  /** Each skill comes with its files (what the tree needs, in one call). */
  files: z.enum(["true", "false"]).optional(),
});
const IdParams = z.object({ id: z.string() });
const RestoreBody = z.object({ seq: z.number().int().min(1) });
const RenameBody = z.object({ name: z.string() });
const MoveBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
const PathQuery = z.object({
  path: z.string().min(1),
  seq: z.coerce.number().int().min(1).optional(),
});
const ExportQuery = z.object({
  seq: z.coerce.number().int().min(1).optional(),
});
const ImportQuery = z.object({
  resolve: z.enum(["replace", "rename"]).optional(),
  name: z.string().optional(),
});
const FileValue = z.object({ value: z.string() });

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

  // Without these, Fastify refuses a zip or a file's bytes. The body stays a
  // Buffer; the routes check what it holds.
  app.addContentTypeParser(
    /^application\/(zip|octet-stream)$/,
    { parseAs: "buffer", bodyLimit: DEFAULT_SKILL_LIMITS.skillBytes },
    (_req, body, done) => done(null, body),
  );

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

  /** The skill to change: found, and in an owner that can be written to. */
  const writable = (req: FastifyRequest): Skill => {
    const skill = skillOf(req);
    requireWritable(skills.ownerOf(skill));
    return skill;
  };

  /** The instructions in SKILL.md, for the simple form; empty if unreadable. */
  const bodyOf = (skill: Skill): string => {
    try {
      return instructionsOf(skills.skillFileText(skill.id));
    } catch {
      return "";
    }
  };

  const detail = (skill: Skill) => ({
    ...skill,
    body: bodyOf(skill),
    files: skills.files(skill.id),
    versions: skills.versions(skill.id),
  });

  const bytesOf = (req: FastifyRequest): Buffer => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      throw new SkillError("Send the file's bytes as the request body.", 400);
    }
    return body;
  };

  /** A path in a query is a path inside the folder, never a way out of it. */
  const pathOf = (req: FastifyRequest) => PathQuery.parse(req.query);

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
      const owner = ownerOf(req);
      // The global page shows the built-in skills too (schemas and data
      // design, decision 51).
      const found = [
        ...(owner.scope === "global" ? skills.builtins() : []),
        ...skills.list(owner, q.deleted === "true"),
      ];
      return q.files === "true"
        ? found.map((s) => ({ ...s, files: skills.files(s.id) }))
        : found;
    });

    app.post(base, async (req, reply) => {
      const owner = ownerOf(req);
      requireWritable(owner);
      const skill = skills.create(owner, SkillBody.parse(req.body));
      announce(skill);
      return reply.code(201).send(detail(skill));
    });

    /** A copy of any skill the caller can see, made in this owner's scope. */
    app.post(`${base}/copy`, async (req, reply) => {
      const owner = ownerOf(req);
      requireWritable(owner);
      const { id } = z.object({ id: z.string() }).parse(req.body);
      const source = skills.get(id);
      if (!source) throw new SkillError("Skill not found.", 404);
      const skill = skills.copyTo(source.id, owner);
      announce(skill);
      return reply.code(201).send(detail(skill));
    });

    /** What importing a zip would do, so the person can see it first. */
    app.post(`${base}/import/preview`, async (req) => {
      const owner = ownerOf(req);
      requireWritable(owner);
      const zip = readSkillZip(bytesOf(req), skills.currentLimits());
      const skillFile = zip.files.find((f) => f.path === SKILL_FILE);
      const text = skillFile?.data.toString("utf-8") ?? "";
      let parsed;
      try {
        parsed = parseSkillFile(text);
      } catch (err) {
        throw new SkillError((err as Error).message, 400);
      }
      if (zip.folder !== null && zip.folder !== parsed.name) {
        throw new SkillError(
          `The folder "${zip.folder}" and the name in SKILL.md ("${parsed.name}") must match.`,
          400,
        );
      }
      const clash = skills.getByName(owner, parsed.name);
      return {
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions.replace(/^\r?\n+/, ""),
        files: zip.files
          .map((f) => ({ path: f.path, size: f.data.length }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        warnings: zip.warnings,
        clash: clash ? { id: clash.id, deleted: clash.deleted } : null,
      };
    });

    app.post(`${base}/import`, async (req, reply) => {
      const owner = ownerOf(req);
      requireWritable(owner);
      const q = ImportQuery.parse(req.query);
      const zip = readSkillZip(bytesOf(req), skills.currentLimits());
      const skillFile = zip.files.find((f) => f.path === SKILL_FILE);
      let parsed;
      try {
        parsed = parseSkillFile(skillFile?.data.toString("utf-8") ?? "");
      } catch (err) {
        throw new SkillError((err as Error).message, 400);
      }
      if (zip.folder !== null && zip.folder !== parsed.name) {
        throw new SkillError(
          `The folder "${zip.folder}" and the name in SKILL.md ("${parsed.name}") must match.`,
          400,
        );
      }
      let files = zip.files;
      let name = parsed.name;
      if (q.resolve === "rename") {
        const newName = (q.name ?? "").trim();
        const problem = skillNameProblem(newName);
        if (problem) throw new SkillError(problem, 400);
        name = newName;
        files = files.map((f) =>
          f.path === SKILL_FILE
            ? {
                ...f,
                data: Buffer.from(
                  renameInSkillFile(f.data.toString("utf-8"), newName),
                  "utf-8",
                ),
              }
            : f,
        );
      }
      const clash = skills.getByName(owner, name);
      if (clash && q.resolve !== "replace") {
        throw new SkillError(
          clash.deleted
            ? `A deleted skill is named "${name}". Restore it, or import under another name.`
            : `A skill named "${name}" already exists here.`,
          409,
        );
      }
      const skill = clash
        ? skills.replaceFiles(clash.id, files)
        : skills.createFromFiles(owner, files);
      announce(skill);
      return reply.code(clash ? 200 : 201).send({
        ...detail(skill),
        warnings: zip.warnings,
      });
    });
  }

  app.get("/api/skills/:id", async (req) => detail(skillOf(req)));

  app.put("/api/skills/:id", async (req) => {
    const current = writable(req);
    const skill = skills.updateText(current.id, TextBody.parse(req.body));
    announce(skill);
    return detail(skill);
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const current = writable(req);
    announce(skills.delete(current.id));
    return reply.code(204).send();
  });

  /** Makes an earlier version current; also restores a deleted skill. */
  app.post("/api/skills/:id/restore", async (req) => {
    const current = writable(req);
    const { seq } = RestoreBody.parse(req.body);
    const skill = skills.restore(current.id, seq);
    announce(skill);
    return detail(skill);
  });

  app.post("/api/skills/:id/rename", async (req) => {
    const current = writable(req);
    const skill = skills.rename(current.id, RenameBody.parse(req.body).name);
    announce(skill);
    return detail(skill);
  });

  app.post("/api/skills/:id/move", async (req) => {
    const current = writable(req);
    const { from, to } = MoveBody.parse(req.body);
    const skill = skills.move(current.id, from, to);
    announce(skill);
    return detail(skill);
  });

  app.get("/api/skills/:id/export", async (req, reply) => {
    const skill = skillOf(req);
    const { seq } = ExportQuery.parse(req.query);
    const files = skills.files(skill.id, seq).flatMap((f) => {
      const read = skills.readFile(skill.id, f.path, seq);
      return read?.data ? [{ path: f.path, data: read.data }] : [];
    });
    return reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(skill.name)}.zip`,
      )
      .send(writeSkillZip(skill.name, files));
  });

  app.get("/api/skills/:id/file", async (req) => {
    const skill = skillOf(req);
    const { path, seq } = pathOf(req);
    const file = skills.readFile(skill.id, path, seq);
    if (!file) throw new SkillError(`No file "${path}".`, 404);
    return {
      path,
      mediaType: file.mediaType,
      size: file.size,
      hash: file.hash,
      missing: file.data === null,
      value:
        file.data && isTextType(file.mediaType)
          ? file.data.toString("utf-8")
          : "",
    };
  });

  app.get("/api/skills/:id/file/raw", async (req, reply) => {
    const skill = skillOf(req);
    const { path, seq } = pathOf(req);
    const file = skills.readFile(skill.id, path, seq);
    if (!file) throw new SkillError(`No file "${path}".`, 404);
    if (!file.data) {
      throw new SkillError("That file's bytes are no longer stored.", 404);
    }
    // Served as a download, never rendered: a skill's files are not ours to
    // run in the page.
    return reply
      .header("content-type", file.mediaType)
      .header("x-content-type-options", "nosniff")
      .send(file.data);
  });

  app.put("/api/skills/:id/file", async (req) => {
    const current = writable(req);
    const { path } = pathOf(req);
    const { value } = FileValue.parse(req.body);
    const skill = skills.writeFile(
      current.id,
      path,
      Buffer.from(value, "utf-8"),
    );
    announce(skill);
    return detail(skill);
  });

  app.put("/api/skills/:id/file/raw", async (req) => {
    const current = writable(req);
    const { path } = pathOf(req);
    const skill = skills.writeFile(current.id, path, bytesOf(req));
    announce(skill);
    return detail(skill);
  });

  app.delete("/api/skills/:id/file", async (req) => {
    const current = writable(req);
    const { path } = pathOf(req);
    const skill = skills.removePath(current.id, path);
    announce(skill);
    return detail(skill);
  });
}
