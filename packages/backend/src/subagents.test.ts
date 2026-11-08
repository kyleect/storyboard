import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type ScriptStep,
} from "@harness/core";
import { allTools, entriesInstruction } from "@harness/tools";
import { AgentStore, type AgentInput } from "./agents-store.js";
import { EntryStore } from "./entries-store.js";
import {
  MAX_QUEUED_USER_MESSAGES,
  MAX_USER_MESSAGE_LENGTH,
  RunManager,
  type RunError,
} from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings, type Settings } from "./settings.js";
import { Store } from "./store.js";
import { grant, clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/*
 * Subagents (agent delegation design): real runs through the HTTP routes and
 * a scripted model. One model serves every run, so a script lists the model
 * calls in the order they happen: parent, child, parent again.
 */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(
  scripts: ScriptStep[][],
  options: {
    settings?: Partial<Settings>;
    /** Keep the built-in Dispatcher (the default). */
    keepDispatcher?: boolean;
    /** The clock, instead of one that ticks a second per call. */
    now?: () => string;
  } = {},
) {
  const t = tempDatabase();
  if (!options.keepDispatcher) clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...options.settings });
  const store = new Store(t.db);
  let clock = 0;
  const now =
    options.now ??
    // A second per call; still a valid time after 60 calls, because a run
    // reads the time for {{date}} and {{time}}.
    (() =>
      new Date(Date.UTC(2026, 10, 5, 0, 0, ++clock))
        .toISOString()
        .replace(".000Z", "Z"));
  const entries = new EntryStore(t.db, now);
  const agents = new AgentStore(t.db, now);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    agents,
    entries,
    systemPrompt: (s) => entriesInstruction(s.project_id !== null),
    now,
  });
  const app = buildServer({ store, runs, entries, token: TOKEN, env: {} });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, agents, entries, scripts };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
    body: (String(res.headers["content-type"] ?? "").includes("json")
      ? res.json()
      : undefined) as Json,
    text: res.body,
  };
}

const call = (callId: string, name: string, args: object = {}): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const text = (t: string): ScriptStep[] => [{ type: "text", text: t }];

const content = (name: string, over: Partial<AgentInput> = {}): AgentInput => ({
  name,
  description: `${name} agent`,
  prompt: `You are ${name}.`,
  toolGrant: grant("deny", []),
  toolApproval: {},
  ...over,
});

/** A global agent that can be started as a subagent. */
const startable = (c: Ctx, name: string, over: Partial<AgentInput> = {}) =>
  c.agents.create(null, content(name, { subagent: true, ...over }));

async function newSession(c: Ctx, agentId: string | null) {
  const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
  const id = body.id as string;
  c.store.setSessionChoices(id, { agentId });
  return id;
}

interface Drive {
  /** Answers to the forms that open, in order, in any run. */
  forms?: (Record<string, unknown> | null)[];
  /** Answers to the approvals that open, in order, in any run. */
  decisions?: ("once" | "deny" | "session")[];
  /** Called on every poll with the session's live runs. */
  onTick?: (live: LiveRuns) => void;
}
type LiveRuns = ReturnType<RunManager["snapshot"]>;

/**
 * Sends a message and answers what opens, in the run that owns it, until the
 * top-level run ends. Returns the run id.
 */
async function go(c: Ctx, sessionId: string, drive: Drive = {}) {
  const res = await api(c.app, "POST", `/api/sessions/${sessionId}/messages`, {
    content: "Go",
  });
  expect(res.status).toBe(202);
  const runId = res.body.runId as string;
  const forms = [...(drive.forms ?? [])];
  const decisions = [...(drive.decisions ?? [])];
  const deadline = Date.now() + 8000;
  while (c.runs.isActive(runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end in time.");
    const live = c.runs.snapshot(sessionId);
    drive.onTick?.(live);
    const all = [
      ...(live.activeRun ? [live.activeRun] : []),
      ...live.childRuns,
    ];
    for (const run of all) {
      const approval = run.approvals[0];
      if (approval) {
        c.runs.answerApproval(run.runId, approval.requestId, {
          choice: decisions.shift() ?? "once",
        });
      }
      const input = run.inputs[0];
      if (input) {
        const next = forms.shift() ?? null;
        c.runs.answerInput(
          run.runId,
          input.requestId,
          next
            ? { outcome: "answered", answers: next }
            : { outcome: "skipped" },
        );
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return runId;
}

/** The child runs of the session, oldest first. */
function childRuns(c: Ctx, sessionId: string) {
  return c.store
    .eventsAfter(sessionId, 0)
    .flatMap((e) =>
      e.type === "run.started" && e.data.parentRunId
        ? [{ runId: e.runId as string, ...e.data }]
        : [],
    );
}

/**
 * The tool results of the session's top-level run, in order, with their
 * data; `all` includes those of subagents' runs.
 */
function results(c: Ctx, sessionId: string, all = false) {
  return c.store
    .listMessages(sessionId, all ? undefined : "top")
    .flatMap((m) =>
      m.message.role === "tool"
        ? [
            {
              callId: m.message.callId,
              name: m.message.name,
              isError: m.message.isError,
              data: m.message.data as Record<string, unknown> | undefined,
              content: m.message.content,
              runId: m.runId,
            },
          ]
        : [],
    );
}

const request = (c: Ctx, n: number) => c.model.requests[n] as ChatRequest;
const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.name);
const systemOf = (r: ChatRequest) =>
  r.messages.find((m) => m.role === "system")?.content as string;

const REMINDER =
  "You have not handed back. If you are finished, call subagent_handback with your result. If you need something from the user, call ask_user.";

describe("a subagent's run", () => {
  it("expands {{date}} and {{time}} when it starts, not from its parent", async () => {
    // A clock that jumps ten minutes per call, so the child starts at a
    // different time of day than its parent.
    let n = 0;
    const now = () =>
      new Date(Date.UTC(2026, 10, 5, 9, 0) + ++n * 10 * 60_000).toISOString();
    const c = await setup(
      [
        [],
        [call("k1", "subagent_handback", { output: "Done." })],
        text("All done"),
      ],
      { now, settings: { systemPrompt: "Now: {{date}} / {{time}}." } },
    );
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const editor = startable(c, "Editor");
    c.scripts[0] = [
      call("p1", "start_subagent", { agentId: editor.id, task: "Edit." }),
    ];
    await go(c, await newSession(c, boss.id));

    const stamp = (r: ChatRequest) =>
      /Now: (.+ \/ \d{2}:\d{2} \S+)\./.exec(systemOf(r))?.[1];
    const parent = stamp(request(c, 0));
    const child = stamp(request(c, 1));
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Both were expanded (no braces left), each at its own start.
    expect(systemOf(request(c, 1))).not.toContain("{{");
    expect(child).not.toBe(parent);
  });

  it("gives the child the files named on start_subagent with its task", async () => {
    const c = await setup([
      [],
      [call("k1", "subagent_handback", { output: "A grey cat." })],
      text("All done"),
    ]);
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const describer = startable(c, "Image Describer");
    const id = await newSession(c, boss.id);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await c.app.inject({
      method: "POST",
      url: `/api/sessions/${id}/files?name=screenshot-1.png`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "image/png",
      },
      payload: png,
    });
    c.scripts[0] = [
      call("p1", "start_subagent", {
        agentId: describer.id,
        task: "Describe the attached image.",
        files: ["<session://screenshot-1.png>"],
      }),
    ];
    await go(c, id);

    // The child's first message is its task, with the file attached.
    const task = c.store
      .listMessages(id)
      .map((m) => m.message)
      .find((m) => m.role === "user" && m.source === "task");
    expect(task).toMatchObject({
      content: "Describe the attached image.",
      files: ["session://screenshot-1.png"],
    });
    // And its request can read the bytes.
    const childRequest = request(c, 1);
    const sent = childRequest.messages.find(
      (m) => m.role === "user" && m.files,
    ) as { files: string[] };
    expect(sent.files).toEqual(["session://screenshot-1.png"]);
    expect(childRequest.resolveFile?.("session://screenshot-1.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: png.toString("base64"),
    });
    // The parent got the child's output.
    expect(results(c, id)[0]).toMatchObject({
      data: { agent: "Image Describer", output: "A grey cat." },
    });
  });

  it("runs as a run of its own and hands its output to the parent", async () => {
    const c = await setup([
      [],
      [call("k1", "subagent_handback", { output: "Tightened." })],
      text("All done"),
    ]);
    const dispatcher = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const editor = startable(c, "Editor");
    // The model script needs the editor's id: patch it into the first step.
    c.scripts[0] = [
      call("p1", "start_subagent", {
        agentId: editor.id,
        task: "Tighten chapter 1",
      }),
    ];
    const id = await newSession(c, dispatcher.id);

    const runId = await go(c, id);

    // The parent got the child's output.
    const [fromChild, handback] = results(c, id);
    expect(fromChild).toMatchObject({
      name: "start_subagent",
      isError: false,
      data: { agent: "Editor", output: "Tightened." },
    });
    expect(handback).toBeUndefined();

    // The child was a run of its own, tied to the call.
    const [child] = childRuns(c, id);
    expect(child).toMatchObject({
      parentRunId: runId,
      parentCallId: "p1",
      agent: { id: editor.id, name: "Editor" },
    });
    const row = c.store.getRun(child?.runId as string);
    expect(row).toMatchObject({
      parent_run_id: runId,
      parent_call_id: "p1",
      agent_id: editor.id,
      status: "finished",
    });
    expect(c.store.getRun(runId)?.status).toBe("finished");
    expect(c.store.getRun(runId)?.parent_run_id).toBeNull();

    // Its request held its system message and the task, nothing else.
    const childRequest = request(c, 1);
    expect(childRequest.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
    ]);
    expect(childRequest.messages[1]?.content).toBe("Tighten chapter 1");
    expect(systemOf(childRequest)).toContain("You are Editor.");
    expect(
      systemOf(childRequest).endsWith("ask_user, not in plain text."),
    ).toBe(true);
    // Only the child is offered the handback tool.
    expect(toolNames(childRequest)).toContain("subagent_handback");
    expect(toolNames(request(c, 0))).not.toContain("subagent_handback");

    // The parent's next request leaves the child's messages out.
    const back = request(c, 2);
    expect(back.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(
      back.messages.some(
        (m) => m.role === "user" && m.content === "Tighten chapter 1",
      ),
    ).toBe(false);
  });

  it("stores the child's messages with their run and call", async () => {
    const c = await setup([[], [], []]);
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      3,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [call("k1", "subagent_handback", { output: "Done." })],
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    const { body } = await api(c.app, "GET", `/api/sessions/${id}`);
    const [child] = childRuns(c, id);
    const nested = (
      body.messages as {
        runId: string | null;
        parentCallId: string | null;
        message: { role: string };
      }[]
    ).filter((m) => m.runId === child?.runId);
    // The task, the handback call and its result.
    expect(nested.map((m) => m.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(nested.every((m) => m.parentCallId === "p1")).toBe(true);
    const top = (
      body.messages as { runId: string | null; parentCallId: string | null }[]
    ).filter((m) => m.runId !== child?.runId && m.runId !== null);
    expect(top.every((m) => m.parentCallId === null)).toBe(true);
  });

  it("sums the subagent's usage over all its calls, apart from the session's own count", async () => {
    const c = await setup([[], [], [], []]);
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      4,
      // The parent starts the child.
      [
        call("p1", "start_subagent", { agentId: editor.id, task: "Do it" }),
        { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } },
      ],
      // The child stops without handing back (a reminder follows), then
      // hands back: two calls.
      [
        { type: "text", text: "Thinking" },
        { type: "usage", usage: { promptTokens: 20, completionTokens: 5 } },
      ],
      [
        call("k1", "subagent_handback", { output: "Done." }),
        { type: "usage", usage: { promptTokens: 30, completionTokens: 6 } },
      ],
      // The parent's last call reports no usage, so the session's latest
      // count is its first call's: not the child's.
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    // All the child's calls, added up.
    const { body } = await api(c.app, "GET", `/api/sessions/${id}`);
    expect(body.subagentUsage).toEqual({
      promptTokens: 50,
      completionTokens: 11,
    });
    expect(c.store.subagentUsage(id)).toEqual({
      promptTokens: 50,
      completionTokens: 11,
    });

    // The session lists leave the child's messages out, as the chat header
    // does.
    const list = await api(c.app, "GET", "/api/sessions");
    const rows = list.body as unknown as { id: string; usage: unknown }[];
    expect(rows.find((r) => r.id === id)?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
    });
  });

  it("has no subagent usage for a session that started none", async () => {
    const c = await setup([text("Hi")]);
    const id = await newSession(c, null);
    await go(c, id);
    const { body } = await api(c.app, "GET", `/api/sessions/${id}`);
    expect(body.subagentUsage).toBeNull();
  });

  it("reminds a child that stops without handing back, then takes the handback", async () => {
    const c = await setup([[], [], [], []]);
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      4,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      text("I think I am done"),
      [call("k1", "subagent_handback", { output: "Really done." })],
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    const reminded = request(c, 2).messages.at(-1);
    expect(reminded).toEqual({
      role: "user",
      content: REMINDER,
      source: "reminder",
    });
    expect(results(c, id)[0]?.data).toMatchObject({ output: "Really done." });
    // The reminder is part of the child's stored messages.
    const [child] = childRuns(c, id);
    const stored = c.store
      .listMessages(id, { run: child?.runId as string })
      .map((m) => m.message);
    expect(stored.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("takes the last text as the output when the reminders run out", async () => {
    const c = await setup([[], [], [], []]);
    const editor = startable(c, "Editor", { childReminders: 1 });
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      4,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      text("First try"),
      text("Final words"),
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    expect(c.model.requests).toHaveLength(4);
    expect(results(c, id)[0]).toMatchObject({
      isError: false,
      data: { output: "Final words" },
    });
  });

  it("gives the parent an error when the child ends with nothing", async () => {
    const c = await setup([[], [], []]);
    const editor = startable(c, "Editor", { childReminders: 0 });
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      3,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [{ type: "finish", reason: "stop" }],
      text("Oh well"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    const [r] = results(c, id);
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r?.data)).toContain("handed back nothing");
  });

  it("gives the parent an error and the last text when the child runs out of iterations", async () => {
    const c = await setup([], { settings: { loopLimit: 3 } });
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.push(
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [{ type: "text", text: "Looking" }, call("k1", "files_list")],
      [call("k2", "files_list")],
      [call("k3", "files_list")],
      text("It failed"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    const [r] = results(c, id).filter((x) => x.name === "start_subagent");
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r?.data)).toMatch(/iteration limit/);
    expect(JSON.stringify(r?.data)).toContain("Looking");
    const [child] = childRuns(c, id);
    expect(c.store.getRun(child?.runId as string)?.status).toBe("finished");
  });

  it("refuses an agent that is not marked startable, and starts no run", async () => {
    const c = await setup([[], []]);
    const quiet = c.agents.create(null, content("Quiet"));
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      2,
      [call("p1", "start_subagent", { agentId: quiet.id, task: "Do it" })],
      text("Ok"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    expect(results(c, id)[0]).toMatchObject({ isError: true });
    expect(results(c, id)[0]?.content).toContain("not marked as startable");
    expect(childRuns(c, id)).toEqual([]);
  });

  it("uses the agent's child line and reminders over the global ones", async () => {
    const c = await setup([[], [], [], [], [], [], []], {
      settings: { childPrompt: "GLOBAL LINE" },
    });
    const own = startable(c, "Own", { childPrompt: "OWN LINE" });
    const none = startable(c, "None", { childPrompt: "" });
    const plain = startable(c, "Plain");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const handback = [call("k", "subagent_handback", { output: "ok" })];
    c.scripts.splice(
      0,
      7,
      [call("p1", "start_subagent", { agentId: own.id, task: "a" })],
      handback,
      [call("p2", "start_subagent", { agentId: none.id, task: "b" })],
      handback,
      [call("p3", "start_subagent", { agentId: plain.id, task: "c" })],
      handback,
      text("End"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id);

    expect(systemOf(request(c, 1)).endsWith("OWN LINE")).toBe(true);
    // Set to empty: no line at all.
    expect(systemOf(request(c, 3))).not.toContain("LINE");
    expect(systemOf(request(c, 3))).not.toContain("subagent_handback");
    // Not set: the global line.
    expect(systemOf(request(c, 5)).endsWith("GLOBAL LINE")).toBe(true);
  });
});

describe("what a subagent asks of the user", () => {
  it("shows its form in its own run, and answers it by that run's id", async () => {
    const c = await setup([[], [], [], []]);
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      4,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [
        call("k1", "ask_user", {
          schema: {
            title: "Question",
            properties: { name: { type: "string", title: "Name" } },
            required: ["name"],
          },
        }),
      ],
      [call("k2", "subagent_handback", { output: "Hello" })],
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    const seen: {
      parentInputs: number;
      childAgent: string | null;
      childInputs: number;
      parentCallId: string;
    }[] = [];
    await go(c, id, {
      forms: [{ name: "Ada" }],
      onTick: (live) => {
        const child = live.childRuns[0];
        if (child && child.inputs.length > 0) {
          seen.push({
            parentInputs: live.activeRun?.inputs.length ?? 0,
            childAgent: child.agent?.name ?? null,
            childInputs: child.inputs.length,
            parentCallId: child.parentCallId,
          });
        }
      },
    });

    // The form was open in the child's run, labelled with its agent, tied to
    // the parent's call; the parent had none of its own.
    expect(seen[0]).toEqual({
      parentInputs: 0,
      childAgent: "Editor",
      childInputs: 1,
      parentCallId: "p1",
    });
    expect(
      results(c, id, true).find((r) => r.name === "ask_user")?.data,
    ).toEqual({
      name: "Ada",
    });
    expect(results(c, id, true).find((r) => r.name === "ask_user")?.runId).toBe(
      childRuns(c, id)[0]?.runId,
    );
  });

  it("asks the child's approvals by its agent's settings, and 'session' covers every run", async () => {
    const c = await setup([[], [], [], [], [], []]);
    const writer = startable(c, "Writer", {
      toolApproval: { current_date: true },
    });
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      6,
      [call("p1", "start_subagent", { agentId: writer.id, task: "a" })],
      [call("k1", "current_date")],
      [call("k2", "subagent_handback", { output: "ok" })],
      [call("p2", "start_subagent", { agentId: writer.id, task: "b" })],
      [
        call("k3", "current_date"),
        call("k4", "subagent_handback", { output: "ok" }),
      ],
      text("End"),
    );
    const id = await newSession(c, boss.id);
    const owners: string[] = [];
    await go(c, id, {
      // First start_subagent: once. current_date in the child: for the session.
      decisions: ["once", "session", "once"],
      onTick: (live) => {
        for (const run of [
          ...(live.activeRun ? [live.activeRun] : []),
          ...live.childRuns,
        ]) {
          for (const a of run.approvals)
            owners.push(`${a.name}@${run.agent?.name}`);
        }
      },
    });

    expect(owners[0]).toBe("start_subagent@Boss");
    expect(owners).toContain("current_date@Writer");
    // Allowed for the session in the first child, so the second one did not ask.
    expect(owners.filter((o) => o.startsWith("current_date"))).toHaveLength(1);
  });
});

describe("a subagent and files", () => {
  it("lets the parent read what the child wrote to the session", async () => {
    const c = await setup([[], [], [], [], []]);
    const writer = startable(c, "Writer");
    const boss = c.agents.create(
      null,
      content("Boss", {
        toolGrant: grant("allow", ["start_subagent", "files_read"]),
      }),
    );
    c.scripts.splice(
      0,
      5,
      [call("p1", "start_subagent", { agentId: writer.id, task: "Write it" })],
      [
        call("k1", "files_write", {
          scope: "session",
          key: "plan.md",
          mediaType: "text/markdown",
          value: "# Plan",
        }),
      ],
      [call("k2", "subagent_handback", { output: "Wrote plan.md" })],
      [call("p2", "files_read", { key: "plan.md" })],
      text("Read it"),
    );
    const id = await newSession(c, boss.id);
    await go(c, id, { forms: [{ name: "plan.md", scope: "session" }] });

    const read = results(c, id).find((r) => r.name === "files_read");
    expect(read?.isError).toBe(false);
    expect(JSON.stringify(read?.data)).toContain("# Plan");
    // The parent's request never held the child's messages.
    expect(
      request(c, 3).messages.some(
        (m) => m.role === "user" && m.content === "Write it",
      ),
    ).toBe(false);
    // The session's files are still the whole session's.
    const files = await api(c.app, "GET", `/api/sessions/${id}/files`);
    expect(JSON.stringify(files.body)).toContain("plan.md");
  });
});

describe("cancelling", () => {
  it("stops the whole tree when the parent is cancelled", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const c = await setup([[], []]);
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      2,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [{ type: "wait", until: hold }],
    );
    const id = await newSession(c, boss.id);
    const res = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "Go",
    });
    const runId = res.body.runId as string;
    // The start_subagent call asks first; approve it.
    await expect
      .poll(() => c.runs.snapshot(id).activeRun?.approvals.length)
      .toBe(1);
    const approval = c.runs.snapshot(id).activeRun?.approvals[0];
    c.runs.answerApproval(runId, approval?.requestId as string, {
      choice: "once",
    });
    await expect.poll(() => c.runs.snapshot(id).childRuns.length).toBe(1);
    const childId = c.runs.snapshot(id).childRuns[0]?.runId as string;

    // Cancelling by the child's id stops the run it belongs to.
    expect(c.runs.cancel(childId)).toBe(true);
    release();
    await expect.poll(() => c.runs.isActive(runId)).toBe(false);
    expect(c.runs.isActive(childId)).toBe(false);
    expect(c.store.getRun(runId)?.status).toBe("cancelled");
    expect(c.store.getRun(childId)?.status).toBe("cancelled");
  });
});

describe("depth", () => {
  it("does not offer start_subagent when subagents are off", async () => {
    const c = await setup([text("Hi")], { settings: { subagentDepth: 0 } });
    const boss = c.agents.create(null, content("Boss"));
    const id = await newSession(c, boss.id);
    await go(c, id);
    expect(toolNames(request(c, 0))).not.toContain("start_subagent");
  });

  it("offers it to a child only while the limit allows", async () => {
    const run = async (subagentDepth: number) => {
      const c = await setup([[], [], []], { settings: { subagentDepth } });
      const editor = startable(c, "Editor");
      const boss = c.agents.create(null, content("Boss"));
      c.scripts.splice(
        0,
        3,
        [call("p1", "start_subagent", { agentId: editor.id, task: "x" })],
        [call("k1", "subagent_handback", { output: "ok" })],
        text("End"),
      );
      const id = await newSession(c, boss.id);
      await go(c, id);
      return [request(c, 0), request(c, 1)].map(toolNames);
    };
    const [topOne, childOne] = await run(1);
    expect(topOne).toContain("start_subagent");
    expect(childOne).not.toContain("start_subagent");
    const [, childTwo] = await run(2);
    expect(childTwo).toContain("start_subagent");
  });

  it("runs a grandchild with only its own messages, and hands back up the chain", async () => {
    const c = await setup([[], [], [], [], [], []]);
    const critic = startable(c, "Critic");
    const editor = startable(c, "Editor");
    const boss = c.agents.create(null, content("Boss"));
    c.scripts.splice(
      0,
      6,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Edit" })],
      [call("e1", "start_subagent", { agentId: critic.id, task: "Critique" })],
      [call("c1", "subagent_handback", { output: "Needs work" })],
      [call("e2", "subagent_handback", { output: "Edited after critique" })],
      text("End"),
      text("unused"),
    );
    const id = await newSession(c, boss.id);
    const runId = await go(c, id);

    const [first, second] = childRuns(c, id);
    expect(first).toMatchObject({ parentRunId: runId, parentCallId: "p1" });
    expect(second).toMatchObject({
      parentRunId: first?.runId,
      parentCallId: "e1",
    });
    expect(request(c, 2).messages.map((m) => m.role)).toEqual([
      "system",
      "user",
    ]);
    expect(request(c, 2).messages[1]?.content).toBe("Critique");
    // The editor's own request holds its task and its start_subagent call.
    expect(request(c, 3).messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(
      results(c, id, true).filter((r) => r.name === "start_subagent")[0]?.data,
    ).toMatchObject({ output: "Needs work" });
    expect(
      results(c, id, true).filter((r) => r.name === "start_subagent")[1]?.data,
    ).toMatchObject({ output: "Edited after critique" });
  });
});

describe("the built-in Dispatcher", () => {
  it("is added by the migration and is read-only", async () => {
    const c = await setup([], { keepDispatcher: true });
    const list = await api(c.app, "GET", "/api/global/agents");
    const dispatcher = (
      list.body as {
        id: string;
        name: string;
        builtin: boolean;
        toolGrant: unknown;
      }[]
    ).find((a) => a.name === "Dispatcher");
    expect(dispatcher).toMatchObject({
      id: "builtin-dispatcher",
      builtin: true,
      toolGrant: {
        mode: "allow",
        groups: [],
        except: [],
        extras: ["ask_user", "agents_list", "start_subagent"],
      },
    });
    const body = {
      name: "Dispatcher",
      prompt: "x",
      toolGrant: grant("deny", []),
    };
    expect(
      (await api(c.app, "PUT", "/api/agents/builtin-dispatcher", body)).status,
    ).toBe(409);
    expect(
      (await api(c.app, "DELETE", "/api/agents/builtin-dispatcher")).status,
    ).toBe(409);
    expect(
      (
        await api(c.app, "POST", "/api/agents/builtin-dispatcher/restore", {
          seq: 1,
        })
      ).status,
    ).toBe(409);
    expect(c.agents.get("builtin-dispatcher")?.deleted).toBe(false);
    expect(
      (await api(c.app, "GET", "/api/agents/builtin-dispatcher/export")).status,
    ).toBe(200);
  });

  it("is offered to every session, labelled, and is the default agent", async () => {
    const c = await setup([], { keepDispatcher: true });
    const mine = c.agents.create(null, content("Mine"));
    const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
    expect(body.agent_id).toBe("builtin-dispatcher");
    const picker = (await api(c.app, "GET", `/api/sessions/${body.id}/agents`))
      .body as { id: string; builtin: boolean; isDefault: boolean }[];
    expect(picker.map((a) => [a.id, a.builtin, a.isDefault])).toEqual([
      [mine.id, false, false],
      ["builtin-dispatcher", true, true],
      ["builtin-media-describer", true, false],
    ]);
  });

  it("gives way to a project's default and to the global default", async () => {
    const c = await setup([], { keepDispatcher: true });
    const global = c.agents.create(null, content("Global one"));
    const p = (await api(c.app, "POST", "/api/projects", { name: "P" })).body
      .id as string;
    const own = c.agents.create(p, content("Project one"));

    writeSettings(c.t.db, { defaultAgentId: global.id });
    const standalone = await api(c.app, "POST", "/api/sessions", {});
    expect(standalone.body.agent_id).toBe(global.id);

    c.store.updateProject(p, { defaultAgentId: own.id });
    const inProject = await api(c.app, "POST", "/api/sessions", {
      projectId: p,
    });
    expect(inProject.body.agent_id).toBe(own.id);

    // Another project with no default falls back to the global one.
    const q = (await api(c.app, "POST", "/api/projects", { name: "Q" })).body
      .id as string;
    expect(
      (await api(c.app, "POST", "/api/sessions", { projectId: q })).body
        .agent_id,
    ).toBe(global.id);
  });

  it("shares a name with a user's agent, and an import of that name does not replace it", async () => {
    const c = await setup([], { keepDispatcher: true });
    const mine = await api(c.app, "POST", "/api/global/agents", {
      name: "Dispatcher",
      prompt: "Mine.",
      toolGrant: grant("deny", []),
    });
    expect(mine.status).toBe(201);
    const imported = await api(c.app, "POST", "/api/global/agents/import", {
      markdown: "---\nname: Dispatcher\n---\n\nMine, imported.\n",
    });
    // It conflicts with the user's own agent of that name, not the built-in.
    expect(imported.status).toBe(409);
    expect(imported.body.conflict.agentId).toBe(mine.body.id);
    expect(c.agents.get("builtin-dispatcher")?.prompt).toContain("entry point");
  });

  it("is included in the migration's own version history", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const agents = new AgentStore(t.db);
    expect(agents.versions("builtin-dispatcher")).toHaveLength(1);
    expect(agents.version("builtin-dispatcher", 1)).toMatchObject({
      name: "Dispatcher",
      subagent: false,
    });
  });

  it("can start an agent through a whole run", async () => {
    const c = await setup([[], [], []], { keepDispatcher: true });
    const editor = startable(c, "Editor");
    c.scripts.splice(
      0,
      3,
      [
        { type: "text", text: "Hello! What would you like to work on?" },
        call("p1", "start_subagent", { agentId: editor.id, task: "Edit it" }),
      ],
      [call("k1", "subagent_handback", { output: "Edited." })],
      text("Done. What next?"),
    );
    const { body } = await api(c.app, "POST", "/api/sessions", { title: "T" });
    await go(c, body.id as string);
    // The files and memory tools are no longer always on, so the Dispatcher,
    // whose grant names neither group, has only its three tools (files
    // unification plan, Q11: no migration).
    expect(toolNames(request(c, 0)).sort()).toEqual(
      ["agents_list", "ask_user", "start_subagent"].sort(),
    );
    expect(results(c, body.id as string)[0]?.data).toMatchObject({
      output: "Edited.",
    });
  });
});

describe("agent settings for subagents", () => {
  const body = (over: object = {}) => ({
    name: "Writer",
    prompt: "P",
    toolGrant: grant("deny", []),
    ...over,
  });

  it("saves them with each version and brings them back on restore", async () => {
    const c = await setup([]);
    const created = await api(
      c.app,
      "POST",
      "/api/global/agents",
      body({ subagent: true, childReminders: 3, childPrompt: "Hand back." }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      subagent: true,
      childReminders: 3,
      childPrompt: "Hand back.",
    });
    const id = created.body.id as string;
    const changed = await api(c.app, "PUT", `/api/agents/${id}`, body());
    expect(changed.body).toMatchObject({
      subagent: false,
      childReminders: null,
      childPrompt: null,
    });
    const restored = await api(c.app, "POST", `/api/agents/${id}/restore`, {
      seq: 1,
    });
    expect(restored.body).toMatchObject({
      subagent: true,
      childReminders: 3,
      childPrompt: "Hand back.",
      version: 3,
    });
  });

  it("refuses a negative or fractional reminder count", async () => {
    const c = await setup([]);
    for (const childReminders of [-1, 1.5]) {
      const res = await api(
        c.app,
        "POST",
        "/api/global/agents",
        body({ childReminders }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("leaves existing agents not startable", async () => {
    const c = await setup([]);
    const res = await api(c.app, "POST", "/api/global/agents", body());
    expect(res.body.subagent).toBe(false);
  });

  it("exports and imports them in the front matter", async () => {
    const c = await setup([]);
    const created = await api(
      c.app,
      "POST",
      "/api/global/agents",
      body({ subagent: true, childReminders: 0 }),
    );
    const exported = await api(
      c.app,
      "GET",
      `/api/agents/${created.body.id}/export`,
    );
    expect(exported.text).toContain("subagent: true");
    await api(c.app, "DELETE", `/api/agents/${created.body.id}`);
    const again = await api(c.app, "POST", "/api/global/agents/import", {
      markdown: exported.text,
      replace: true,
    });
    expect(again.body.agent).toMatchObject({
      subagent: true,
      childReminders: 0,
    });
  });
});

describe("subagent settings", () => {
  it("has defaults, and environment variables override them", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    expect(readSettings(t.db, {}).effective).toMatchObject({
      childReminders: 2,
      subagentDepth: 2,
      childPrompt: expect.stringContaining("subagent_handback"),
    });
    const env = {
      HARNESS_CHILD_REMINDERS: "5",
      HARNESS_SUBAGENT_DEPTH: "0",
      HARNESS_CHILD_PROMPT: "Custom line",
    };
    expect(readSettings(t.db, env).effective).toMatchObject({
      childReminders: 5,
      subagentDepth: 0,
      childPrompt: "Custom line",
    });
    expect(() => readSettings(t.db, { HARNESS_SUBAGENT_DEPTH: "-1" })).toThrow(
      /HARNESS_SUBAGENT_DEPTH/,
    );
  });

  it("can be saved, with an empty child line", async () => {
    const c = await setup([]);
    const res = await api(c.app, "PUT", "/api/settings", {
      childReminders: 4,
      childPrompt: "",
      subagentDepth: 3,
    });
    expect(res.status).toBe(200);
    expect(readSettings(c.t.db, {}).effective).toMatchObject({
      childReminders: 4,
      childPrompt: "",
      subagentDepth: 3,
    });
  });
});

const LABEL =
  "Message from the user (not from the agent that gave you your task):";

describe("a message from the user to a running subagent", () => {
  /**
   * A boss that starts an Editor. The Editor asks a form, so it is waiting
   * (with its form open) while the test sends; then it hands back.
   */
  async function waitingChild(settings: Partial<Settings> = {}) {
    const c = await setup([[], [], [], []], { settings });
    const editor = startable(c, "Editor");
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    c.scripts.splice(
      0,
      4,
      [call("p1", "start_subagent", { agentId: editor.id, task: "Do it" })],
      [
        call("k1", "ask_user", {
          schema: {
            title: "Question",
            properties: { name: { type: "string", title: "Name" } },
            required: ["name"],
          },
        }),
      ],
      [call("k2", "subagent_handback", { output: "Done" })],
      text("Fine"),
    );
    const id = await newSession(c, boss.id);
    return { c, id };
  }

  /** Runs the session; calls `act` once, when the child's form is open. */
  async function sendWhileAsking(
    c: Ctx,
    id: string,
    act: (live: LiveRuns, childRunId: string) => void,
  ) {
    let acted = false;
    await go(c, id, {
      forms: [{ name: "Ada" }],
      onTick: (live) => {
        const child = live.childRuns[0];
        if (!acted && child && child.inputs.length > 0) {
          acted = true;
          act(live, child.runId);
        }
      },
    });
    expect(acted).toBe(true);
  }

  it("is read at the start of the child's next step, with the label, and stored in order", async () => {
    const { c, id } = await waitingChild();
    await sendWhileAsking(c, id, (_live, runId) => {
      c.runs.sendUserMessage(runId, "  Use tool_b, not tool_a.  ");
    });

    // Parent call, then the child's two calls: the second one reads it.
    const read = request(c, 2).messages.at(-1);
    expect(read).toEqual({
      role: "user",
      content: `${LABEL}\n\nUse tool_b, not tool_a.`,
      source: "user",
    });
    // It comes after the form's answer, which the step that was running got.
    const roles = request(c, 2).messages.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);

    const [child] = childRuns(c, id);
    const stored = c.store
      .listMessages(id, { run: child?.runId as string })
      .map((m) => m.message);
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
    ]);
    expect(stored[0]).toMatchObject({ source: "task" });
    expect(stored[3]).toMatchObject({ source: "user" });
    // The parent never saw it.
    expect(
      c.store
        .listMessages(id, "top")
        .some((m) => m.message.role === "user" && m.message.source === "user"),
    ).toBe(false);
    // The event the panel uses to show it was read.
    const added = c.store
      .eventsAfter(id, 0)
      .find((e) => e.type === "user.message");
    expect(added).toMatchObject({
      runId: child?.runId,
      data: { source: "user", content: expect.stringContaining("tool_b") },
    });
  });

  it("shows the waiting messages in the run's snapshot until it reads them", async () => {
    const { c, id } = await waitingChild();
    const waiting: string[][] = [];
    await sendWhileAsking(c, id, (_live, runId) => {
      expect(c.runs.sendUserMessage(runId, "one")).toBe(1);
      expect(c.runs.sendUserMessage(runId, "two")).toBe(2);
      waiting.push(c.runs.snapshot(id).childRuns[0]?.userMessages ?? []);
    });
    expect(waiting[0]).toEqual(["one", "two"]);
    // Both are read together, oldest first, as two messages.
    const last = request(c, 2).messages.slice(-2);
    expect(last.map((m) => m.content)).toEqual([
      `${LABEL}\n\none`,
      `${LABEL}\n\ntwo`,
    ]);
  });

  it("sends the text as typed when the label is empty", async () => {
    const { c, id } = await waitingChild({ subagentMessageLabel: "" });
    await sendWhileAsking(c, id, (_live, runId) => {
      c.runs.sendUserMessage(runId, "Just this");
    });
    expect(request(c, 2).messages.at(-1)).toMatchObject({
      content: "Just this",
    });
  });

  it("refuses an empty or long message and too many waiting", async () => {
    const { c, id } = await waitingChild();
    const errors: [number | undefined, string][] = [];
    await sendWhileAsking(c, id, (_live, runId) => {
      const attempt = (text: string) => {
        try {
          c.runs.sendUserMessage(runId, text);
        } catch (err) {
          errors.push([(err as RunError).statusCode, (err as Error).message]);
        }
      };
      attempt("   ");
      attempt("x".repeat(MAX_USER_MESSAGE_LENGTH + 1));
      for (let i = 0; i < MAX_QUEUED_USER_MESSAGES + 1; i++) attempt("ok");
    });
    expect(errors).toEqual([
      [400, "The message is empty."],
      [
        400,
        `The message is longer than ${MAX_USER_MESSAGE_LENGTH} characters.`,
      ],
      [
        409,
        `${MAX_QUEUED_USER_MESSAGES} messages are already waiting; wait for the subagent to read them.`,
      ],
    ]);
  });

  it("is refused for a top-level run", async () => {
    const { c, id } = await waitingChild();
    const errors: [number | undefined, string][] = [];
    await sendWhileAsking(c, id, (live) => {
      try {
        c.runs.sendUserMessage(live.activeRun?.runId as string, "Hi");
      } catch (err) {
        errors.push([(err as RunError).statusCode, (err as Error).message]);
      }
    });
    expect(errors).toEqual([[400, "Only a subagent's run takes messages."]]);
  });

  it("goes through POST /api/runs/:id/messages, with 400, 404 and 409 when it cannot", async () => {
    const { c, id } = await waitingChild();
    const started = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "Go",
    });
    const topId = started.body.runId as string;
    // Wait for the child's form to open.
    const deadline = Date.now() + 8000;
    let child = c.runs.snapshot(id).childRuns[0];
    while (!child || child.inputs.length === 0) {
      if (Date.now() > deadline) throw new Error("The form did not open.");
      const live = c.runs.snapshot(id);
      for (const run of [
        ...(live.activeRun ? [live.activeRun] : []),
        ...live.childRuns,
      ]) {
        const approval = run.approvals[0];
        if (approval) {
          c.runs.answerApproval(run.runId, approval.requestId, {
            choice: "once",
          });
        }
      }
      await new Promise((r) => setTimeout(r, 5));
      child = c.runs.snapshot(id).childRuns[0];
    }

    const sent = await api(c.app, "POST", `/api/runs/${child.runId}/messages`, {
      text: "Hello",
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ waiting: 1 });
    const empty = await api(
      c.app,
      "POST",
      `/api/runs/${child.runId}/messages`,
      {
        text: " ",
      },
    );
    expect(empty.status).toBe(400);
    const noBody = await api(
      c.app,
      "POST",
      `/api/runs/${child.runId}/messages`,
      {},
    );
    expect(noBody.status).toBe(400);
    const top = await api(c.app, "POST", `/api/runs/${topId}/messages`, {
      text: "Hi",
    });
    expect(top.status).toBe(400);
    const missing = await api(c.app, "POST", "/api/runs/nope/messages", {
      text: "Hi",
    });
    expect(missing.status).toBe(404);

    const input = child.inputs[0];
    c.runs.answerInput(child.runId, input?.requestId as string, {
      outcome: "answered",
      answers: { name: "Ada" },
    });
    while (c.runs.isActive(topId)) await new Promise((r) => setTimeout(r, 5));

    const ended = await api(
      c.app,
      "POST",
      `/api/runs/${child.runId}/messages`,
      {
        text: "Too late",
      },
    );
    expect(ended.status).toBe(409);
    expect(ended.body.error).toBe("The run is not active.");
  });

  it("has a label setting with a default, an environment variable and a save", async () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    expect(readSettings(t.db, {}).effective.subagentMessageLabel).toBe(LABEL);
    expect(
      readSettings(t.db, { HARNESS_SUBAGENT_MESSAGE_LABEL: "From the user:" })
        .effective.subagentMessageLabel,
    ).toBe("From the user:");
    const c = await setup([]);
    const res = await api(c.app, "PUT", "/api/settings", {
      subagentMessageLabel: "",
    });
    expect(res.status).toBe(200);
    expect(readSettings(c.t.db, {}).effective.subagentMessageLabel).toBe("");
  });
});

describe("after a crash", () => {
  it("ends the parent and the child as interrupted, each call answered in its own run", async () => {
    const c = await setup([]);
    const id = await newSession(c, null);
    const at = "2026-11-05T00:00:00Z";
    const assistant = (callId: string, name: string) => ({
      role: "assistant" as const,
      content: [{ type: "tool_call" as const, callId, name, arguments: "{}" }],
    });
    c.store.createRun({ id: "r-parent", sessionId: id, kind: "loop", now: at });
    c.store.createRun({
      id: "r-child",
      sessionId: id,
      kind: "loop",
      now: at,
      parent: { runId: "r-parent", callId: "p1" },
    });
    c.store.saveMessage(id, "m1", assistant("p1", "start_subagent"), at);
    c.store.linkRunMessage("r-parent", "m1");
    c.store.saveMessage(id, "m2", assistant("k1", "files_list"), at);
    c.store.linkRunMessage("r-child", "m2");

    expect(c.runs.recover().sort()).toEqual(["r-child", "r-parent"]);

    expect(c.store.getRun("r-parent")?.status).toBe("interrupted");
    expect(c.store.getRun("r-child")?.status).toBe("interrupted");
    const own = (runId: string) =>
      c.store
        .listMessages(id, { run: runId })
        .flatMap((m) => (m.message.role === "tool" ? [m.message.callId] : []));
    expect(own("r-parent")).toEqual(["p1"]);
    expect(own("r-child")).toEqual(["k1"]);
    // The child's interrupted call stays out of the top-level transcript.
    expect(
      c.store
        .listMessages(id, "top")
        .flatMap((m) => (m.message.role === "tool" ? [m.message.callId] : [])),
    ).toEqual(["p1"]);
  });
});

describe("the session debug export with a subagent", () => {
  it("holds the subagent's run, prompt, tools, messages and events", async () => {
    const c = await setup([
      [],
      [call("k1", "subagent_handback", { output: "Tightened." })],
      text("All done"),
    ]);
    const boss = c.agents.create(
      null,
      content("Boss", { toolGrant: grant("allow", ["start_subagent"]) }),
    );
    const editor = startable(c, "Editor");
    c.scripts[0] = [
      call("p1", "start_subagent", {
        agentId: editor.id,
        task: "Tighten chapter 1",
      }),
    ];
    const id = await newSession(c, boss.id);
    const parentRunId = await go(c, id);

    const res = await api(c.app, "GET", `/api/sessions/${id}/debug`);
    expect(res.status).toBe(200);
    const debug = res.body as {
      runs: {
        id: string;
        parentRunId: string | null;
        parentCallId: string | null;
        request: string;
        systemPrompt: string | null;
        tools: { name: string }[] | null;
      }[];
      messages: { runId: string | null; message: Json }[];
      events: { runId: string | null; type: string; data: Json }[];
    };

    // Two runs: the parent, and the subagent tied to the call that started it.
    expect(debug.runs).toHaveLength(2);
    const parent = debug.runs.find((r) => r.id === parentRunId);
    const child = debug.runs.find((r) => r.parentRunId === parentRunId);
    expect(parent).toBeDefined();
    expect(child).toMatchObject({ parentCallId: "p1", request: "recorded" });

    // What was recorded is what each model call was sent (request 0 is the
    // parent's first call, 1 the subagent's).
    expect(parent?.systemPrompt).toBe(systemOf(request(c, 0)));
    expect(child?.systemPrompt).toBe(systemOf(request(c, 1)));
    expect(child?.systemPrompt).toContain("You are Editor.");
    expect(parent?.systemPrompt).not.toContain("You are Editor.");
    expect(child?.tools?.map((t) => t.name)).toEqual(toolNames(request(c, 1)));
    expect(parent?.tools?.map((t) => t.name)).toEqual(toolNames(request(c, 0)));

    // The subagent's own messages are in the transcript, owned by its run.
    const own = debug.messages.filter((m) => m.runId === child?.id);
    expect(own[0]?.message).toMatchObject({
      role: "user",
      content: "Tighten chapter 1",
    });
    expect(
      own.some(
        (m) =>
          m.message.role === "tool" && m.message.name === "subagent_handback",
      ),
    ).toBe(true);

    // And its events, which name the run that started it.
    const started = debug.events.find(
      (e) => e.runId === child?.id && e.type === "run.started",
    );
    expect(started?.data).toMatchObject({
      parentRunId,
      parentCallId: "p1",
    });
    expect(
      debug.events.some(
        (e) => e.runId === child?.id && e.type === "run.finished",
      ),
    ).toBe(true);
  });
});
