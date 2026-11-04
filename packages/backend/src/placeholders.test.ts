import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
  type Tool,
} from "@harness/core";
import {
  skillLoad,
  skillsInstruction,
  skillsList,
  skillTools,
  SKILL_LOAD,
} from "@harness/tools";
import { AgentStore, type AgentContent } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import {
  expandPlaceholders,
  firstSentence,
  toolsList,
  usesPlaceholder,
} from "./placeholders.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { SkillStore, type SkillContent } from "./skills-store.js";
import { Store } from "./store.js";
import { tempDatabase } from "./test-helpers.js";

/* Placeholders (placeholders design). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

describe("expandPlaceholders (decisions 2 to 6)", () => {
  const values = { skills: "- a: A.", tools: "- t: T." };

  it("replaces {{skills}} and {{tools}}, with spaces allowed inside", () => {
    expect(expandPlaceholders("{{skills}} and {{ tools }}", values)).toBe(
      "- a: A. and - t: T.",
    );
  });

  it("leaves anything else as typed", () => {
    const text = "{{skill}} {{Skills}} {{ }} {skills} {{{}}} {{agents}}";
    expect(expandPlaceholders(text, values)).toBe(text);
  });

  it("does not scan an expansion again", () => {
    const out = expandPlaceholders("{{skills}}", {
      skills: "- a: see {{tools}}",
      tools: "NOPE",
    });
    expect(out).toBe("- a: see {{tools}}");
  });

  it("expands to nothing when the list is empty", () => {
    expect(expandPlaceholders("A {{tools}} B", { skills: "", tools: "" })).toBe(
      "A  B",
    );
  });

  it("tells whether a placeholder is used", () => {
    expect(usesPlaceholder("x {{ skills }}", "skills")).toBe(true);
    expect(usesPlaceholder("x {{tools}}", "skills")).toBe(false);
    expect(usesPlaceholder(undefined, "skills")).toBe(false);
  });
});

describe("toolsList (decision 7)", () => {
  it("gives the first sentence of each description on one line", () => {
    expect(firstSentence("Reads a file.  Takes a path.")).toBe("Reads a file.");
    expect(firstSentence("No full stop")).toBe("No full stop");
    expect(firstSentence("Multi\nline. More.")).toBe("Multi line.");
    expect(
      toolsList([
        { name: "a", description: "Does A. Then more." },
        { name: "b", description: "Does B" },
      ]),
    ).toBe("- a: Does A.\n- b: Does B");
    expect(toolsList([])).toBe("");
  });
});

const tool = (name: string, description = `The ${name} tool. More.`): Tool =>
  defineTool({
    name,
    description,
    input: z.object({}),
    approval: "never",
    execute: () => ({ data: { ran: name } }),
  });

const TOOLS = [tool("alpha"), tool("beta"), tool("files_read"), skillLoad];
const ALWAYS_ON = ["files_read", SKILL_LOAD];

const skill = (over: Partial<SkillContent> = {}): SkillContent => ({
  displayName: "My Skill",
  description: "Use when testing.",
  body: "Do the thing.",
  ...over,
});

const agentContent = (over: Partial<AgentContent> = {}): AgentContent => ({
  name: "Editor",
  description: "",
  prompt: "",
  toolMode: "allow",
  tools: [],
  toolApproval: {},
  ...over,
});

async function setup(scripts: ScriptStep[][]) {
  const t = tempDatabase();
  writeSettings(t.db, { systemPrompt: "" });
  const store = new Store(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const agents = new AgentStore(t.db, now);
  const skills = new SkillStore(t.db, now);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: TOOLS,
    alwaysOnTools: ALWAYS_ON,
    agents,
    skills,
    skillTools: skillTools.map((s) => s.name),
    skillsPrompt: skillsInstruction,
    skillsList,
    systemPrompt: () => "BASE",
    now,
  });
  const app = buildServer({
    store,
    runs,
    agents,
    skills,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  return { t, agents, skills, runs, app, model };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: (res.body === "" ? undefined : JSON.parse(res.body)) as Record<
      string,
      unknown
    >,
  };
}

async function say(
  { app, runs }: { app: FastifyInstance; runs: RunManager },
  session: string,
  agentId?: string,
) {
  const res = await api(app, "POST", `/api/sessions/${session}/messages`, {
    content: "Hi",
    ...(agentId ? { agentId } : {}),
  });
  await expect.poll(() => runs.isActive(res.body.runId as string)).toBe(false);
}

const answer: ScriptStep[] = [{ type: "text", text: "Done" }];
const systemOf = (r: unknown) =>
  (r as ChatRequest).messages.find((m) => m.role === "system")?.content;

async function newSession(app: FastifyInstance) {
  return (await api(app, "POST", "/api/sessions", {})).body.id as string;
}

describe("placeholders in runs", () => {
  it("fills {{skills}} and {{tools}} in each prompt, and drops the default skill list", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "G: {{skills}}" });
    s.skills.create({ scope: "global" }, skill({ description: "Global one." }));
    const agent = (
      await api(
        s.app,
        "POST",
        "/api/global/agents",
        agentContent({ prompt: "Tools:\n{{ tools }}", tools: ["alpha"] }),
      )
    ).body.id as string;
    await say(s, await newSession(s.app), agent);
    const system = systemOf(s.model.requests[0]);
    expect(system).toBe(
      [
        "G: - my-skill: Global one.",
        // Allowed tool and the always-on tools; beta is not selected.
        "Tools:\n- alpha: The alpha tool.\n- files_read: The files_read tool.\n" +
          `- ${SKILL_LOAD}: ${firstSentence(skillLoad.description)}`,
        "BASE",
      ].join("\n\n"),
    );
    // No introduction: the placeholder is the only place for the list.
    expect(system).not.toContain("You have skills");
  });

  it("keeps the default skill list when no prompt has {{skills}}", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "Global. {{tools}}" });
    s.skills.create({ scope: "global" }, skill());
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system).toContain("You have skills");
    expect(system.endsWith("\n\nBASE")).toBe(true);
    expect(system.startsWith("Global. - alpha: The alpha tool.")).toBe(true);
  });

  it("expands to nothing with no skills, and drops a prompt left blank", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "{{skills}}" });
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe("BASE");
    // The skill tool is not offered, so it is not listed either.
  });

  it("lists no skill tool when no skill is in scope, and leaves unknown names", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "{{tools}} {{agents}}" });
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system).not.toContain(SKILL_LOAD);
    expect(system).toContain("{{agents}}");
  });

  it("does not scan a skill description that holds a placeholder", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "{{skills}}" });
    s.skills.create(
      { scope: "global" },
      skill({ description: "See {{tools}}." }),
    );
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      "- my-skill: See {{tools}}.\n\nBASE",
    );
  });

  it("does not expand a skill body", async () => {
    const s = await setup([answer]);
    s.skills.create({ scope: "global" }, skill({ body: "Use {{tools}}." }));
    await say(s, await newSession(s.app));
    expect(s.skills.inScope(null, null)[0]?.body).toBe("Use {{tools}}.");
  });
});
