import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@harness/core";
import type { DebugMessage, DebugRun, SessionDebug } from "../../../api";
import {
  buildLinear,
  filterLinear,
  LINEAR_KINDS,
  NO_LINEAR_FILTER,
  renderLinearText,
} from "./linear";

const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

let id = 0;
const ev = (
  time: number,
  runId: string | null,
  type: string,
  data: unknown,
): StoredEvent =>
  ({
    id: ++id,
    runId,
    sessionId: "s",
    time: t(time),
    type,
    data,
  }) as StoredEvent;

const msg = (
  mid: string,
  createdAt: number | null,
  runId: string | null,
  message: DebugMessage["message"],
): DebugMessage => ({
  id: mid,
  message,
  model: null,
  reasoningEffort: null,
  agent: null,
  usage: null,
  runId,
  parentCallId: null,
  parentId: null,
  branches: null,
  active: true,
  trashed: false,
  createdAt: createdAt === null ? null : t(createdAt),
});

const run = (rid: string, over: Partial<DebugRun> = {}): DebugRun => ({
  id: rid,
  parentRunId: null,
  parentCallId: null,
  kind: "loop",
  status: "finished",
  startedAt: t(1),
  endedAt: t(9),
  model: null,
  reasoningEffort: null,
  agent: null,
  usage: null,
  error: null,
  systemPrompt: "SYS",
  tools: [{ name: "echo", description: "d", inputSchema: {} }],
  request: "recorded",
  ...over,
});

const assistantCall = {
  role: "assistant" as const,
  content: [
    { type: "reasoning" as const, text: "thinking" },
    { type: "tool_call" as const, callId: "c1", name: "echo", arguments: {} },
  ],
};

function session(): SessionDebug {
  id = 0;

  return {
    format: 2,
    exportedAt: t(20),
    session: { id: "s", title: "T" } as SessionDebug["session"],
    project: null,
    runs: [run("A"), run("B", { parentRunId: "A", startedAt: t(5) })],
    messages: [
      msg("u1", 0, null, { role: "user", content: "Hi" }),
      msg("a1", 3, "A", assistantCall),
      msg("tr1", 4, "A", {
        role: "tool",
        callId: "c1",
        name: "echo",
        content: "result text",
        isError: false,
      }),
      msg("task", 5, "B", { role: "user", content: "Do the sub task" }),
      msg("a2", 7, "A", {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      }),
    ],
    events: [
      ev(1, "A", "run.started", { kind: "loop" }),
      ev(2, "A", "step.started", { index: 0 }),
      ev(2, "A", "text.delta", { messageId: "a1", contentIndex: 0, text: "x" }),
      ev(3, "A", "message.finished", {
        messageId: "a1",
        message: assistantCall,
        finishReason: "tool_calls",
      }),
      ev(3, "A", "tool.called", {
        messageId: "a1",
        callId: "c1",
        name: "echo",
      }),
      ev(4, "A", "tool.result", {
        messageId: "tr1",
        callId: "c1",
        name: "echo",
        isError: false,
        preview: "r",
        durationMs: 1,
      }),
      ev(5, "B", "run.started", { kind: "loop", parentRunId: "A" }),
      ev(6, "B", "run.finished", { reason: "handed_back" }),
      ev(7, "A", "message.finished", {
        messageId: "a2",
        message: { role: "assistant", content: [] },
        finishReason: "stop",
      }),
      ev(8, "A", "run.finished", { reason: "stop" }),
    ],
  };
}

describe("buildLinear", () => {
  it("lays the session out in the order it happened", () => {
    const items = buildLinear(session());

    expect(items.map((i) => `${i.kind}:${i.title}`)).toEqual([
      "user:User",
      "event:run.started",
      "system:System prompt",
      "tools:Tools (1)",
      "assistant:Assistant · tool_calls",
      "tool:Result of echo",
      "user:User",
      "event:run.started",
      "system:System prompt",
      "tools:Tools (1)",
      "event:run.finished",
      "assistant:Assistant · stop",
      "event:run.finished",
    ]);
  });

  it("titles a user message by where it came from and puts it at its event", () => {
    const base = session();
    const items = buildLinear({
      ...base,
      messages: [
        ...base.messages,
        msg("sent", 6, "B", {
          role: "user",
          content: "Label\n\nUse tool_b",
          source: "user",
        }),
        msg("rem", 6, "B", {
          role: "user",
          content: "Hand back.",
          source: "reminder",
        }),
      ],
      events: [
        ...base.events,
        ev(6, "B", "user.message", {
          messageId: "sent",
          source: "user",
          content: "Label\n\nUse tool_b",
        }),
      ],
    });
    const sent = items.find((i) => i.text === "Label\n\nUse tool_b");

    expect(sent?.title).toBe("User (sent to the subagent)");
    expect(items.filter((i) => i.text === "Label\n\nUse tool_b")).toHaveLength(
      1,
    );
    expect(items.find((i) => i.text === "Hand back.")?.title).toBe(
      "User (reminder)",
    );
  });

  it("leaves out what a message already holds", () => {
    const types = buildLinear(session())
      .filter((i) => i.kind === "event")
      .map((i) => i.title);

    for (const repeat of ["step.started", "text.delta", "tool.called"]) {
      expect(types).not.toContain(repeat);
    }
  });

  it("carries the content: reasoning, calls and results", () => {
    const items = buildLinear(session());
    const assistant = items.find((i) => i.key.startsWith("e-4"));

    expect(assistant?.blocks?.map((b) => b.type)).toEqual([
      "reasoning",
      "tool_call",
    ]);
    expect(items.find((i) => i.kind === "tool")?.text).toBe("result text");
    expect(items.find((i) => i.kind === "system")?.text).toBe("SYS");
  });

  it("indents a subagent's items", () => {
    const items = buildLinear(session());
    const depths = items.filter((i) => i.runId === "B").map((i) => i.depth);

    expect(depths.length).toBeGreaterThan(0);
    expect(new Set(depths)).toEqual(new Set([1]));
    expect(
      items.filter((i) => i.runId === "A").every((i) => i.depth === 0),
    ).toBe(true);
  });

  it("says so when a run's system prompt was not recorded", () => {
    const s = session();

    s.runs = [
      run("A", { request: "not_recorded", systemPrompt: null, tools: null }),
    ];
    const system = buildLinear(s).find((i) => i.kind === "system");

    expect(system?.text).toMatch(/Not recorded/);
    expect(buildLinear(s).some((i) => i.kind === "tools")).toBe(false);
  });

  it("keeps a message no event places, by its time, and one with no time last", () => {
    const s = session();

    s.messages.push(
      msg("late", null, "A", { role: "user", content: "no time" }),
      msg("partial", 6, "A", {
        role: "assistant",
        content: [{ type: "text", text: "cut off" }],
      }),
    );
    const titles = buildLinear(s).map(
      (i) => i.raw && (i.raw as { id?: string }).id,
    );
    const at = (m: string) => titles.indexOf(m);

    expect(at("partial")).toBeGreaterThan(at("task"));
    expect(at("partial")).toBeLessThan(at("a2"));
    expect(at("late")).toBe(titles.length - 1);
  });

  it("shows a repeated finish of one message as an event, not a second copy", () => {
    const s = session();

    s.events.splice(
      4,
      0,
      ev(3, "A", "message.finished", {
        messageId: "a1",
        message: assistantCall,
        finishReason: "stop",
      }),
    );
    const items = buildLinear(s);

    expect(
      items.filter(
        (i) =>
          i.kind === "assistant" &&
          i.raw &&
          (i.raw as { id?: string }).id === "a1",
      ),
    ).toHaveLength(1);
    expect(items.filter((i) => i.title === "message.finished")).toHaveLength(1);
  });
});

describe("filterLinear", () => {
  it("filters by kind, run and text (also inside tool arguments)", () => {
    const items = buildLinear(session());

    expect(
      filterLinear(items, { ...NO_LINEAR_FILTER, kinds: ["user"] }),
    ).toHaveLength(2);
    expect(
      filterLinear(items, { ...NO_LINEAR_FILTER, runId: "B" }).every(
        (i) => i.runId === "B",
      ),
    ).toBe(true);
    expect(
      filterLinear(items, { ...NO_LINEAR_FILTER, text: "RESULT TEXT" }).map(
        (i) => i.kind,
      ),
    ).toEqual(["tool"]);
    expect(
      filterLinear(items, { ...NO_LINEAR_FILTER, text: "echo" }).length,
    ).toBeGreaterThan(0);
    expect(filterLinear(items, NO_LINEAR_FILTER)).toHaveLength(items.length);
    expect(NO_LINEAR_FILTER.kinds).toEqual(LINEAR_KINDS);
  });
});

describe("renderLinearText", () => {
  const LONG = `failure: ${"x".repeat(300)} END`;

  function detailed(): SessionDebug {
    const s = session();

    s.session = { id: "s", title: "My story" } as SessionDebug["session"];
    s.messages[1] = {
      ...(s.messages[1] as DebugMessage),
      model: "qwen",
      reasoningEffort: "low",
      usage: { promptTokens: 120, completionTokens: 30 },
    };
    s.messages[2] = msg("tr1", 4, "A", {
      role: "tool",
      callId: "c1",
      name: "echo",
      content: "result text",
      isError: false,
      decisionComment: { text: "ok but be careful", choice: "once" },
      data: { structured: true },
    });
    s.runs[0] = run("A", {
      tools: [
        {
          name: "echo",
          description: "Echoes its input.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
      ],
    });
    s.events.push(ev(9, "A", "run.failed", { error: LONG }));

    return s;
  }

  it("starts with a header that says how to read it", () => {
    const text = renderLinearText(detailed());

    expect(text).toMatch(
      /^# Session debug export\nSession: My story \(s\)\nProject: none/,
    );
    expect(text).toContain("Runs: 2 · Messages: 5 · Events: 11");
    expect(text).toContain("Items are in the order they happened.");
    expect(text).toContain(
      "edit messages merged into neighbouring user messages",
    );
  });

  it("is in order: user, run, system prompt, tools, reply, result", () => {
    const text = renderLinearText(detailed());
    const at = (needle: string) => text.indexOf(needle);
    const order = [
      "] User -----",
      "] run.started",
      "] System prompt",
      "] Tools (1)",
      "] Assistant · tool_calls",
      "] Result of echo",
    ].map(at);

    expect(order.every((n) => n >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("does not shorten anything: events, tools, decision comments", () => {
    const text = renderLinearText(detailed());

    expect(text).toContain(LONG);
    expect(text).toContain("tool echo: Echoes its input.");
    expect(text).toContain(
      'input schema: {"type":"object","properties":{"text":{"type":"string"}}}',
    );
    expect(text).toContain(
      "model qwen · reasoning low · tokens in 120 / out 30",
    );
    expect(text).toContain("[details]");
    expect(text).toContain("ok but be careful");
    expect(text).toContain('"structured": true');
    expect(text).toContain("run id: A");
    expect(text).toContain("subagent, depth 1");
  });

  it("shows reasoning and tool calls inside an assistant message", () => {
    const text = renderLinearText(detailed());

    expect(text).toContain("[reasoning]\nthinking");
    expect(text).toContain("[tool call echo id=c1]");
  });

  it("leaves a result's data out when the content already says it", () => {
    const s = session();

    s.messages[2] = msg("tr1", 4, "A", {
      role: "tool",
      callId: "c1",
      name: "echo",
      content: '{"a":1}',
      isError: false,
      data: { a: 1 },
    });
    expect(renderLinearText(s)).not.toContain("[details]");
  });

  it("says when a run's system prompt was not recorded", () => {
    const s = session();

    s.runs = [
      run("A", { request: "not_recorded", systemPrompt: null, tools: null }),
    ];
    expect(renderLinearText(s)).toContain(
      "Not recorded: this run was made before",
    );
  });
});

describe("subagents in the linear view", () => {
  function withCall(): SessionDebug {
    const s = session();

    s.runs[1] = run("B", {
      parentRunId: "A",
      parentCallId: "c1",
      startedAt: t(5),
    });

    return s;
  }

  it("ties the call that started a subagent to its run, both ways", () => {
    const items = buildLinear(withCall());
    const assistant = items.find((i) => i.kind === "assistant");

    expect(assistant?.calls).toEqual({ c1: "starts run 2 (B)" });
    const started = items.find(
      (i) => i.title === "run.started" && i.runId === "B",
    );

    expect(started?.meta).toBe("started by call c1 in run 1 (A)");

    const text = renderLinearText(withCall());

    expect(text).toContain("[tool call echo id=c1 → starts run 2 (B)]");
    expect(text).toContain("started by call c1 in run 1 (A)");
  });

  it("does not tie a call that started nothing", () => {
    const items = buildLinear(session());

    expect(items.find((i) => i.kind === "assistant")?.calls).toBeUndefined();
  });

  it("times a run's prompt and tools by the run.started event, not the run row", () => {
    const s = session();

    s.runs[0] = run("A", { startedAt: t(0) });
    const items = buildLinear(s);
    const startedAt = items.find(
      (i) => i.title === "run.started" && i.runId === "A",
    )?.time;

    expect(startedAt).toBe(t(1));

    for (const kind of ["system", "tools"] as const) {
      expect(items.find((i) => i.kind === kind && i.runId === "A")?.time).toBe(
        startedAt,
      );
    }

    const times = items.flatMap((i) => (i.time === null ? [] : [i.time]));

    expect(times).toEqual([...times].sort());
  });
});
