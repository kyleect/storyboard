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
  skillsList,
  SKILL_LOAD,
  startSubagent,
} from "@harness/tools";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import {
  agentsList,
  expandPlaceholders,
  filesList,
  FILE_DESCRIPTION_MAX,
  firstSentence,
  formatDate,
  formatTime,
  PlaceholderError,
  toolsList,
  usesPlaceholder,
} from "./placeholders.js";
import { EntryStore } from "./entries-store.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { DEFAULTS, readSettings, writeSettings } from "./settings.js";
import { SkillStore, type SkillContent } from "./skills-store.js";
import { Store } from "./store.js";
import { grant, clearBuiltins, tempDatabase } from "./test-helpers.js";

/* Placeholders (placeholders design). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

describe("expandPlaceholders (decisions 2 to 6)", () => {
  const values = {
    skills: "- a: A.",
    skills_instruction: "Use skills.",
    tools: "- t: T.",
    schemas: "- S.",
    schemas_instruction: "Use schemas.",
    tools_instruction: "Use tools.",
    data_instruction: "Use data.",
    agents_instruction: "Use agents.",
    workspaces_instruction: "Use workspaces.",
    files: "- <session://a.md> (text/markdown)",
    files_instruction: "Use files.",
    data: "- S: D.",
    agents: "- (a1) Ed: Edits.",
    workspaces: "- Notes: workspace://w1/ (read-only)",
    date: "Friday, November 6, 2026",
    time: "14:32 UTC",
  };

  it("replaces {{date}} and {{time}}, with spaces allowed inside", () => {
    expect(expandPlaceholders("{{date}}, {{ time }}. {{Date}}", values)).toBe(
      "Friday, November 6, 2026, 14:32 UTC. {{Date}}",
    );
    expect(usesPlaceholder("x {{ date }}", "date")).toBe(true);
    expect(usesPlaceholder("x {{time}}", "date")).toBe(false);
  });

  it("replaces {{skills}} and {{tools}}, with spaces allowed inside", () => {
    expect(expandPlaceholders("{{skills}} and {{ tools }}", values)).toBe(
      "- a: A. and - t: T.",
    );
  });

  it("replaces {{schemas}} (schemas and data design, decision 39)", () => {
    expect(expandPlaceholders("<s>{{ schemas }}</s>", values)).toBe(
      "<s>- S.</s>",
    );
    expect(usesPlaceholder("x {{schemas}}", "schemas")).toBe(true);
  });

  it("replaces {{data}}", () => {
    expect(expandPlaceholders("<d>{{ data }}</d>", values)).toBe(
      "<d>- S: D.</d>",
    );
    expect(usesPlaceholder("x {{data}}", "data")).toBe(true);
    expect(usesPlaceholder("x {{schemas}}", "data")).toBe(false);
  });

  it("leaves anything else as typed", () => {
    const text =
      "{{skill}} {{Skills}} {{ }} {skills} {{{}}} {{Agents}} {{agent}}";
    expect(expandPlaceholders(text, values)).toBe(text);
  });

  it("replaces {{agents}}", () => {
    expect(expandPlaceholders("<a>{{ agents }}</a>", values)).toBe(
      "<a>- (a1) Ed: Edits.</a>",
    );
    expect(usesPlaceholder("x {{agents}}", "agents")).toBe(true);
    expect(usesPlaceholder("x {{agents}}", "tools")).toBe(false);
  });

  it("does not scan an expansion again", () => {
    const out = expandPlaceholders("{{skills}}", {
      skills: "- a: see {{tools}}",
      tools: "NOPE",
      schemas: "",
      data: "",
      agents: "",
      workspaces: "",
      skills_instruction: "",
      schemas_instruction: "",
      tools_instruction: "",
      data_instruction: "",
      agents_instruction: "",
      workspaces_instruction: "",
      files: "",
      files_instruction: "",
      date: "",
      time: "",
    });
    expect(out).toBe("- a: see {{tools}}");
  });

  it("expands to nothing when the list is empty", () => {
    expect(
      expandPlaceholders("A {{tools}} B", {
        skills: "",
        tools: "",
        schemas: "",
        data: "",
        agents: "",
        workspaces: "",
        skills_instruction: "",
        schemas_instruction: "",
        tools_instruction: "",
        data_instruction: "",
        agents_instruction: "",
        workspaces_instruction: "",
        files: "",
        files_instruction: "",
        date: "",
        time: "",
      }),
    ).toBe("A  B");
  });

  it("replaces {{skills_instruction}} and {{schemas_instruction}}, apart from the lists", () => {
    expect(
      expandPlaceholders(
        "{{skills_instruction}}|{{ schemas_instruction }}|{{skills}}",
        values,
      ),
    ).toBe("Use skills.|Use schemas.|- a: A.");
  });

  it("replaces each instruction placeholder and {{files}}", () => {
    expect(
      expandPlaceholders(
        "{{tools_instruction}}|{{data_instruction}}|{{agents_instruction}}|{{workspaces_instruction}}|{{files_instruction}}|{{files}}",
        values,
      ),
    ).toBe(
      "Use tools.|Use data.|Use agents.|Use workspaces.|Use files.|- <session://a.md> (text/markdown)",
    );
  });

  it("tells whether a placeholder is used", () => {
    expect(usesPlaceholder("x {{ skills }}", "skills")).toBe(true);
    expect(usesPlaceholder("x {{tools}}", "skills")).toBe(false);
    expect(usesPlaceholder(undefined, "skills")).toBe(false);
    // The instruction and the list are different placeholders.
    expect(usesPlaceholder("{{skills_instruction}}", "skills")).toBe(false);
    expect(
      usesPlaceholder("{{skills_instruction}}", "skills_instruction"),
    ).toBe(true);
  });
});

describe("formatDate and formatTime", () => {
  // 2026-11-06 22:32 UTC is the evening of the 6th in London and in Los
  // Angeles it is 14:32 PST on the same day; in Tokyo it is already the 7th.
  const at = new Date(Date.UTC(2026, 10, 6, 22, 32, 5));

  it("gives the weekday and the date", () => {
    expect(formatDate(at, "UTC")).toBe("Friday, November 6, 2026");
    expect(formatDate(at, "America/Los_Angeles")).toBe(
      "Friday, November 6, 2026",
    );
    expect(formatDate(at, "Asia/Tokyo")).toBe("Saturday, November 7, 2026");
  });

  it("gives the time on a 24-hour clock with the zone's short name", () => {
    expect(formatTime(at, "UTC")).toBe("22:32 UTC");
    expect(formatTime(at, "America/Los_Angeles")).toBe("14:32 PST");
  });

  it("writes midnight as 00:xx, not 24:xx", () => {
    expect(formatTime(new Date(Date.UTC(2026, 10, 7, 0, 5)), "UTC")).toBe(
      "00:05 UTC",
    );
  });

  it("uses the computer's own zone when none is given", () => {
    expect(formatTime(at)).toMatch(/^\d{2}:\d{2} \S+$/);
    expect(formatDate(at)).toMatch(/^\w+day, \w+ \d{1,2}, 2026$/);
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

describe("agentsList", () => {
  const a = (over: Partial<Parameters<typeof agentsList>[0][number]> = {}) => ({
    id: "id1",
    name: "Editor",
    description: "Edits prose.",
    subagent: true,
    ...over,
  });

  it("gives the id, name and description of each startable agent", () => {
    expect(
      agentsList([
        a(),
        a({ id: "id2", name: "Critic", description: "Critiques." }),
      ]),
    ).toBe("- (id1) Editor: Edits prose.\n- (id2) Critic: Critiques.");
  });

  it("leaves out agents that are not startable, and is empty with none", () => {
    expect(agentsList([a({ subagent: false })])).toBe("");
    expect(agentsList([])).toBe("");
  });

  it("keeps a description on one line, and drops an empty one", () => {
    expect(agentsList([a({ description: "Two\n  lines." })])).toBe(
      "- (id1) Editor: Two lines.",
    );
    expect(agentsList([a({ description: "  " })])).toBe("- (id1) Editor");
  });
});

const tool = (
  name: string,
  description = `The ${name} tool. More.`,
  alwaysOn = false,
): Tool =>
  defineTool({
    name,
    description,
    input: z.object({}),
    approval: "never",
    group: "utilities" as const,
    alwaysOn,
    execute: () => ({ data: { ran: name } }),
  });

const TOOLS = [
  tool("alpha"),
  tool("beta"),
  tool("files_read", "The files_read tool. More.", true),
  skillLoad,
];

const skill = (over: Partial<SkillContent> = {}): SkillContent => ({
  displayName: "My Skill",
  description: "Use when testing.",
  body: "Do the thing.",
  ...over,
});

const agentContent = (over: Partial<AgentInput> = {}): AgentInput => ({
  name: "Editor",
  description: "",
  prompt: "",
  toolGrant: grant("allow", []),
  toolApproval: {},
  ...over,
});

async function setup(
  scripts: ScriptStep[][],
  tools: readonly Tool[] = TOOLS,
  extra: (
    t: ReturnType<typeof tempDatabase>,
  ) => Partial<ConstructorParameters<typeof RunManager>[0]> = () => ({}),
) {
  const t = tempDatabase();
  clearBuiltins(t.db);
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
    tools,
    agents,
    skills,
    skillsList,
    systemPrompt: () => "BASE",
    now,
    ...extra(t),
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
    agentId: agentId ?? null,
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
        agentContent({
          prompt: "Tools:\n{{ tools }}",
          toolGrant: grant("allow", ["alpha"]),
        }),
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

  it("puts the skills instruction setting before the list when no prompt places either", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, {
      systemPrompt: "Global.",
      skillsInstruction: "Custom skills wording.",
    });
    s.skills.create({ scope: "global" }, skill({ description: "Global one." }));
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      "Global.\n\nCustom skills wording.\n\n- my-skill: Global one.\n\nBASE",
    );
  });

  it("sends the list alone when the skills instruction setting is empty", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "Global.", skillsInstruction: "" });
    s.skills.create({ scope: "global" }, skill({ description: "Global one." }));
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      "Global.\n\n- my-skill: Global one.\n\nBASE",
    );
  });

  it("fills {{skills_instruction}} and {{skills}} apart, and then inserts nothing", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, {
      systemPrompt:
        "<how>{{skills_instruction}}</how>\n<list>{{skills}}</list>",
      skillsInstruction: "Custom skills wording.",
    });
    s.skills.create({ scope: "global" }, skill({ description: "Global one." }));
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      "<how>Custom skills wording.</how>\n<list>- my-skill: Global one.</list>\n\nBASE",
    );
  });

  it("does not insert the list after a prompt that places only {{skills_instruction}}", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "{{skills_instruction}}" });
    s.skills.create({ scope: "global" }, skill());
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      `${DEFAULTS.skillsInstruction}\n\nBASE`,
    );
  });

  it("leaves {{skills_instruction}} empty when no skill is in scope", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "A{{skills_instruction}}B" });
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe("AB\n\nBASE");
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
    writeSettings(s.t.db, { systemPrompt: "{{tools}} {{agent}}" });
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system).not.toContain(SKILL_LOAD);
    expect(system).toContain("{{agent}}");
  });

  describe("{{agents}}", () => {
    const WITH_START = [...TOOLS, startSubagent];

    it("lists the agents the run can start, and no others", async () => {
      const s = await setup([answer], WITH_START);
      writeSettings(s.t.db, { systemPrompt: "A:\n{{agents}}" });
      const editor = s.agents.create(
        null,
        agentContent({
          name: "Editor",
          description: "Edits prose.",
          subagent: true,
        }),
      );
      s.agents.create(
        null,
        agentContent({ name: "Notes", description: "Not startable." }),
      );
      await say(s, await newSession(s.app));
      expect(systemOf(s.model.requests[0])).toBe(
        `A:\n- (${editor.id}) Editor: Edits prose.\n\nBASE`,
      );
    });

    it("lists a project's agents first, then the global ones", async () => {
      const s = await setup([answer], WITH_START);
      writeSettings(s.t.db, { systemPrompt: "{{agents}}" });
      const project = (await api(s.app, "POST", "/api/projects", { name: "P" }))
        .body.id as string;
      const global = s.agents.create(
        null,
        agentContent({ name: "Aaa global", subagent: true }),
      );
      const own = s.agents.create(
        project,
        agentContent({ name: "Zzz project", subagent: true }),
      );
      // An agent of another project is not offered here.
      const other = (await api(s.app, "POST", "/api/projects", { name: "Q" }))
        .body.id as string;
      s.agents.create(other, agentContent({ name: "Other", subagent: true }));
      const session = (
        await api(s.app, "POST", "/api/sessions", { projectId: project })
      ).body.id as string;
      await say(s, session);
      expect(systemOf(s.model.requests[0])).toBe(
        `- (${own.id}) Zzz project\n- (${global.id}) Aaa global\n\nBASE`,
      );
    });

    it("leaves out the run's own agent, which cannot start itself", async () => {
      const s = await setup([answer], WITH_START);
      writeSettings(s.t.db, { systemPrompt: "A:\n{{agents}}" });
      const editor = s.agents.create(
        null,
        agentContent({
          name: "Editor",
          subagent: true,
          toolGrant: grant("allow", ["start_subagent"]),
        }),
      );
      const critic = s.agents.create(
        null,
        agentContent({ name: "Critic", subagent: true }),
      );
      await say(s, await newSession(s.app), editor.id);
      expect(systemOf(s.model.requests[0])).toBe(
        `A:\n- (${critic.id}) Critic\n\nBASE`,
      );
    });

    it("is empty when the run is not offered start_subagent", async () => {
      // The default tools have no start_subagent.
      const s = await setup([answer]);
      writeSettings(s.t.db, { systemPrompt: "A{{agents}}" });
      s.agents.create(null, agentContent({ subagent: true }));
      await say(s, await newSession(s.app));
      expect(systemOf(s.model.requests[0])).toBe("A\n\nBASE");
    });

    it("is empty at the depth limit, and when the agent does not allow start_subagent", async () => {
      const s = await setup([answer, answer], WITH_START);
      writeSettings(s.t.db, { systemPrompt: "A{{agents}}" });
      s.agents.create(null, agentContent({ subagent: true }));
      const boss = s.agents.create(
        null,
        agentContent({ name: "Boss", toolGrant: grant("allow", ["alpha"]) }),
      );
      await say(s, await newSession(s.app), boss.id);
      expect(systemOf(s.model.requests[0])).toBe("A\n\nBASE");

      writeSettings(s.t.db, { subagentDepth: 0 });
      await say(s, await newSession(s.app));
      expect(systemOf(s.model.requests[1])).toBe("A\n\nBASE");
    });
  });

  it("fills {{date}} and {{time}} from the clock when the run starts", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, {
      systemPrompt: "Today is {{date}}.",
    });
    const agent = (
      await api(
        s.app,
        "POST",
        "/api/global/agents",
        agentContent({ prompt: "It is {{ time }}." }),
      )
    ).body.id as string;
    await say(s, await newSession(s.app), agent);
    const system = systemOf(s.model.requests[0]) as string;
    // The test clock starts at 2026-01-01T00:00:00Z and ticks a second per
    // call, so the date and time are the formatted run start, in whatever
    // zone the test computer is in.
    const date = system.match(/^Today is (.+)\.\n\n/)?.[1];
    const time = system.match(/It is (.+)\.\n\nBASE$/)?.[1];
    expect(date).toMatch(/^\w+day, (December|January) \d{1,2}, (2025|2026)$/);
    expect(time).toMatch(/^\d{2}:\d{2} \S+$/);
    expect(system).not.toContain("{{");
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

describe("filesList", () => {
  it("is empty for no files", () => {
    expect(filesList([])).toBe("");
  });

  it("gives the reference and media type, and a description only when there is one", () => {
    expect(
      filesList([
        { scope: "global", key: "style/voice.md", mediaType: "text/markdown" },
        {
          scope: "session",
          key: "My Photo.png",
          mediaType: "image/png",
          description: "  A cat\non a\n  sofa. ",
        },
      ]),
    ).toBe(
      [
        "- <global://style/voice.md> (text/markdown)",
        "- <session://My Photo.png> (image/png): A cat on a sofa.",
      ].join("\n"),
    );
  });

  it("cuts a long description at the limit with an ellipsis", () => {
    const line = filesList([
      {
        scope: "project",
        key: "a.wav",
        mediaType: "audio/wav",
        description: "word ".repeat(100),
      },
    ]);
    const description = line.split("): ")[1] as string;
    expect(description.endsWith("…")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(FILE_DESCRIPTION_MAX + 1);
  });
});

describe("Mustache templates", () => {
  const values = {
    skills: "- a: A.",
    skills_instruction: "",
    schemas_instruction: "",
    tools_instruction: "",
    data_instruction: "",
    agents_instruction: "",
    workspaces_instruction: "",
    files: "",
    files_instruction: "",
    tools: "- t: T.",
    schemas: "",
    data: "",
    agents: "",
    workspaces: "",
    date: "Friday, November 6, 2026",
    time: "14:32 UTC",
  };
  const none = { ...values, skills: "" };

  it("does not HTML-escape a value", () => {
    const text = `- a: "quoted" <b> & it's x/y`;
    expect(
      expandPlaceholders("{{skills}}|{{{skills}}}|{{&skills}}", {
        ...values,
        skills: text,
      }),
    ).toBe(`${text}|${text}|${text}`);
  });

  it("keeps a section only when the placeholder has text", () => {
    const text = "{{#skills}}Skills:\n{{skills}}{{/skills}}";
    expect(expandPlaceholders(text, values)).toBe("Skills:\n- a: A.");
    expect(expandPlaceholders(text, none)).toBe("");
  });

  it("keeps an inverted section only when the placeholder is empty", () => {
    const text = "{{^skills}}No skills.{{/skills}}";
    expect(expandPlaceholders(text, values)).toBe("");
    expect(expandPlaceholders(text, none)).toBe("No skills.");
  });

  it("gives {{.}} inside a section as the placeholder's text", () => {
    expect(expandPlaceholders("{{#skills}}[{{.}}]{{/skills}}", values)).toBe(
      "[- a: A.]",
    );
  });

  it("leaves no blank lines where a section's own lines were", () => {
    const text = "A\n{{#skills}}\n{{skills}}\n{{/skills}}\nB";
    expect(expandPlaceholders(text, values)).toBe("A\n- a: A.\nB");
    expect(expandPlaceholders(text, none)).toBe("A\nB");
  });

  it("drops a comment", () => {
    expect(expandPlaceholders("A{{! a note }}B", values)).toBe("AB");
  });

  it("leaves a variable tag that is not a placeholder as typed", () => {
    const text =
      "{{skils}} {{ Skills }} {{a.b}} {{.}} {{{agent}}} {{&nope}} {{ }} {{{}}}";
    expect(expandPlaceholders(text, values)).toBe(text);
  });

  it("keeps each of them in place between known ones and inside a section", () => {
    const text =
      "{{date}}\n  {{typo}} and {{tools}}\n{{#skills}}\n{{typo2}} {{skills}}\n{{/skills}}\n{{ other }}";
    expect(expandPlaceholders(text, values)).toBe(
      "Friday, November 6, 2026\n  {{typo}} and - t: T.\n{{typo2}} - a: A.\n{{ other }}",
    );
  });

  it("refuses a section on a name that is not a placeholder", () => {
    expect(() =>
      expandPlaceholders("A\n  {{#skils}}x{{/skils}}", values),
    ).toThrow(/"skils" is not a placeholder.*\(line 2, column 3\)/);
    expect(() => expandPlaceholders("{{^nope}}x{{/nope}}", values)).toThrow(
      PlaceholderError,
    );
  });

  it("refuses partials and changed delimiters", () => {
    expect(() => expandPlaceholders("{{> part}}", values)).toThrow(
      /Partials are not supported \(line 1, column 1\)/,
    );
    expect(() => expandPlaceholders("x\n{{=<% %>=}}", values)).toThrow(
      /delimiters.*\(line 2, column 1\)/,
    );
  });

  it("reports a template that does not parse, with the line and column", () => {
    expect(() => expandPlaceholders("ok\nUse {{ here", values)).toThrow(
      /^Unclosed tag \(line 2, column \d+\)$/,
    );
    expect(() => expandPlaceholders("{{#skills}} x", values)).toThrow(
      /^Unclosed section "skills" \(line 1, column \d+\)$/,
    );
    expect(() => expandPlaceholders("{{/skills}}", values)).toThrow(
      /^Unopened section "skills" \(line 1, column 1\)$/,
    );
  });

  it("counts only a variable tag as using a placeholder", () => {
    expect(usesPlaceholder("{{{skills}}}", "skills")).toBe(true);
    expect(usesPlaceholder("{{&skills}}", "skills")).toBe(true);
    expect(
      usesPlaceholder("{{#skills}}x {{skills}}{{/skills}}", "skills"),
    ).toBe(true);
    expect(usesPlaceholder("{{#skills}}only a test{{/skills}}", "skills")).toBe(
      false,
    );
    expect(usesPlaceholder("{{! skills }}", "skills")).toBe(false);
  });

  it("does not count a template that is not valid", () => {
    expect(usesPlaceholder("{{skills", "skills")).toBe(false);
    expect(usesPlaceholder("{{#nope}}{{skills}}{{/nope}}", "skills")).toBe(
      false,
    );
  });
});

describe("Mustache templates in runs", () => {
  const CONDITIONAL =
    "{{#skills}}Skills:\n{{skills}}{{/skills}}{{^skills}}No skills.{{/skills}}";

  it("uses a section to word the skill list, and adds no default one", async () => {
    const s = await setup([answer, answer]);
    writeSettings(s.t.db, { systemPrompt: CONDITIONAL });
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe("No skills.\n\nBASE");

    s.skills.create({ scope: "global" }, skill());
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[1]);
    expect(system).toBe("Skills:\n- my-skill: Use when testing.\n\nBASE");
    expect(system).not.toContain("You have skills");
  });

  it("does not HTML-escape what a list holds", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "{{skills}}" });
    s.skills.create(
      { scope: "global" },
      skill({ description: `Use for "dialogue" & <tags>, it's x/y.` }),
    );
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      `- my-skill: Use for "dialogue" & <tags>, it's x/y.\n\nBASE`,
    );
  });

  it("fails the run before the model is called when the global prompt is not a valid template", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: "Fine.\nBroken {{#skills}} here" });
    const session = await newSession(s.app);
    await say(s, session);

    expect(s.model.requests).toHaveLength(0);
    const run = new Store(s.t.db).listRuns(session)[0];
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(
      /^Global system prompt: Unclosed section "skills" \(line 2, column \d+\)$/,
    );
    // Recorded as the failed run it is, for the errors console.
    const recorded = s.t.db
      .prepare("SELECT kind, message FROM errors WHERE session_id = ?")
      .all(session) as { kind: string; message: string }[];
    expect(recorded).toEqual([
      { kind: "run_failed", message: run?.error as string },
    ]);
  });

  it("names the agent's prompt when that is the one that is not valid", async () => {
    const s = await setup([answer]);
    const agent = (
      await api(
        s.app,
        "POST",
        "/api/global/agents",
        agentContent({ prompt: "Use {{#skils}}x{{/skils}}" }),
      )
    ).body.id as string;
    const session = await newSession(s.app);
    await say(s, session, agent);

    expect(s.model.requests).toHaveLength(0);
    const run = new Store(s.t.db).listRuns(session)[0];
    expect(run?.error).toMatch(
      /^Agent prompt: "skils" is not a placeholder.*\(line 1, column 5\)$/,
    );
  });
});

describe("the default global prompt", () => {
  const render = (values: Parameters<typeof expandPlaceholders>[1]) =>
    expandPlaceholders(DEFAULTS.systemPrompt, values);
  const nothing = {
    skills: "",
    skills_instruction: "",
    schemas_instruction: "",
    tools_instruction: DEFAULTS.toolsInstruction,
    data_instruction: "",
    agents_instruction: "",
    workspaces_instruction: "",
    files: "",
    files_instruction: "",
    tools: "- t: T.",
    schemas: "",
    data: "",
    agents: "",
    workspaces: "",
    date: "Friday, November 6, 2026",
    time: "14:32 UTC",
  };
  const everything = {
    ...nothing,
    skills: "- a: A.",
    schemas: "- S: a shape.",
    data: "- S: a piece of data",
    agents: "- (a1) Ed: Edits.",
    workspaces: "- Notes: workspace://w1/ (read-only)",
    files: "- <session://a.md> (text/markdown)",
    skills_instruction: DEFAULTS.skillsInstruction,
    schemas_instruction: DEFAULTS.schemasInstruction,
    data_instruction: DEFAULTS.dataInstruction,
    agents_instruction: DEFAULTS.agentsInstruction,
    workspaces_instruction: DEFAULTS.workspacesInstruction,
    files_instruction: DEFAULTS.filesInstruction,
  };
  const blocks = ["skills", "schemas", "data", "agents", "workspaces", "files"];

  it("leaves out a block that has nothing to list", () => {
    const out = render(nothing);
    for (const name of blocks) expect(out).not.toContain(`<${name}>`);
    expect(out).toContain("<tools>\nYou have tools:\n\n- t: T.\n</tools>");
    expect(out).toContain("Today is Friday, November 6, 2026.");
  });

  it("has each block, closed, when there is something to list", () => {
    const out = render(everything);
    for (const name of blocks) {
      expect(out).toMatch(new RegExp(`<${name}>\\n[\\s\\S]+\\n</${name}>`));
    }
    expect(out).toContain("- a: A.\n</skills>");
    expect(out).toContain("- (a1) Ed: Edits.\n</agents>");
    expect(out).toContain("- <session://a.md> (text/markdown)\n</files>");
    // Each block opens with its instruction setting.
    expect(out).toContain(`<skills>\n${DEFAULTS.skillsInstruction}\n\n`);
    expect(out).toContain(`<files>\n${DEFAULTS.filesInstruction}\n\n`);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("tells the model how to load a skill, with the tool's real name", () => {
    expect(DEFAULTS.skillsInstruction).toContain(
      `call ${SKILL_LOAD} with its name`,
    );
  });

  it("takes each block's wording from the settings, not the prompt's text", () => {
    for (const name of [
      "skills",
      "tools",
      "schemas",
      "data",
      "agents",
      "workspaces",
      "files",
    ]) {
      expect(DEFAULTS.systemPrompt).toContain(`{{${name}_instruction}}`);
    }
  });

  it("gives the skill introduction once in a run, not again as the default list", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: DEFAULTS.systemPrompt });
    s.skills.create({ scope: "global" }, skill());
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system.match(/You have skills/g)).toHaveLength(1);
    expect(system).toContain("<skills>\nYou have skills:");
    expect(system).toContain("- my-skill: Use when testing.\n</skills>");
  });

  it("sends no skills block when there are no skills", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: DEFAULTS.systemPrompt });
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system).not.toContain("<skills>");
    expect(system).not.toContain("You have skills");
  });
});

describe("instruction placeholders and {{files}} in runs", () => {
  const withEntries = (t: ReturnType<typeof tempDatabase>) => ({
    entries: new EntryStore(t.db),
  });

  it("fills {{tools_instruction}} from the setting, apart from {{tools}}", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, {
      systemPrompt: "<how>{{tools_instruction}}</how>\n{{tools}}",
      toolsInstruction: "Custom tools wording.",
    });
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system.startsWith("<how>Custom tools wording.</how>\n- ")).toBe(
      true,
    );
    expect(system.split("Custom tools wording.")).toHaveLength(2);
  });

  it("leaves each instruction empty when its list is", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, {
      systemPrompt:
        "[{{data_instruction}}][{{agents_instruction}}][{{workspaces_instruction}}][{{files_instruction}}][{{files}}]",
    });
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe("[][][][][]\n\nBASE");
  });

  it("lists the global, project and session files, with a description for a binary file", async () => {
    const s = await setup([answer], TOOLS, withEntries);
    const entries = new EntryStore(s.t.db);
    writeSettings(s.t.db, {
      systemPrompt: "{{files_instruction}}\n{{files}}",
      filesInstruction: "Custom files wording.",
    });
    const project = (await api(s.app, "POST", "/api/projects", { name: "P" }))
      .body.id as string;
    const shared = entries.shared(project);
    shared.put(
      "file",
      "global",
      { key: "voice.md", value: "Plain.", mediaType: "text/markdown" },
      { by: "user" },
    );
    shared.put(
      "file",
      "project",
      { key: "cast/alice.md", value: "Alice.", mediaType: "text/markdown" },
      { by: "user" },
    );
    const session = (
      await api(s.app, "POST", "/api/sessions", { projectId: project })
    ).body.id as string;
    await say(s, session);
    expect(systemOf(s.model.requests[0])).toBe(
      [
        "Custom files wording.",
        "- <global://voice.md> (text/markdown)",
        "- <project://cast/alice.md> (text/markdown)",
        "",
        "BASE",
      ].join("\n"),
    );
  });

  it("does not list project files in a chat that is not in a project", async () => {
    const s = await setup([answer], TOOLS, withEntries);
    const entries = new EntryStore(s.t.db);
    writeSettings(s.t.db, { systemPrompt: "{{files}}" });
    entries
      .shared(null)
      .put(
        "file",
        "global",
        { key: "voice.md", value: "Plain.", mediaType: "text/markdown" },
        { by: "user" },
      );
    await say(s, await newSession(s.app));
    expect(systemOf(s.model.requests[0])).toBe(
      "- <global://voice.md> (text/markdown)\n\nBASE",
    );
  });

  it("sends no <files> block from the default prompt when there are no files", async () => {
    const s = await setup([answer]);
    writeSettings(s.t.db, { systemPrompt: DEFAULTS.systemPrompt });
    await say(s, await newSession(s.app));
    const system = systemOf(s.model.requests[0]) as string;
    expect(system).not.toContain("<files>");
    expect(system).not.toContain("{{files}}");
    expect(system).toContain(`<tools>\n${DEFAULTS.toolsInstruction}\n\n`);
  });
});
