import {
  ScriptedModel,
  type ChatRequest,
  type ModelAdapter,
  type ModelChunk,
  type ModelRequest,
  type ScriptStep,
  type ToolDefinition,
} from "@harness/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  lastRecordedRun,
  recordedRequest,
  requestHandoff,
  type HandoffInput,
} from "./handoff.js";
import { DEFAULTS, readSettings } from "./settings.js";
import { tempDatabase, type TempDatabase } from "./test-helpers.js";
import type { RunRow } from "./store.js";

const say = (words: string): ScriptStep[] => [{ type: "text", text: words }];
const never = () => new Promise<void>(() => {});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tool: ToolDefinition = {
  name: "current_date",
  description: "Today's date.",
  inputSchema: { type: "object" },
};

const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  prompt: "WRITE THE NOTE",
  messages: [{ role: "user", content: "hello" }],
  model: null,
  reasoningEffort: null,
  thinkMs: 1000,
  totalMs: 1000,
  maxTokens: 500,
  ...over,
});

/** The one chat request a ScriptedModel received. */
const sent = (model: ScriptedModel): ChatRequest => {
  const request = model.requests[0];
  if (request?.kind !== "chat") throw new Error("expected a chat request");
  return request;
};

describe("handoff settings", () => {
  let t: TempDatabase | undefined;
  afterEach(() => t?.cleanup());

  it("has the documented defaults", () => {
    expect(DEFAULTS.rolloverHandoff).toBe(true);
    expect(DEFAULTS.rolloverHandoffThinkSeconds).toBe(60);
    expect(DEFAULTS.rolloverHandoffTotalSeconds).toBe(180);
    expect(DEFAULTS.rolloverHandoffMaxTokens).toBe(8000);
    expect(DEFAULTS.rolloverHandoffPrompt).toMatch(
      /^This session has run out of room\./,
    );
    expect(DEFAULTS.rolloverHandoffPrompt).toMatch(
      /Reply with the note only\.$/,
    );
  });

  it("reads the environment variables", () => {
    t = tempDatabase();
    const view = readSettings(t.db, {
      HARNESS_ROLLOVER_HANDOFF: "false",
      HARNESS_ROLLOVER_HANDOFF_THINK_SECONDS: "5",
      HARNESS_ROLLOVER_HANDOFF_TOTAL_SECONDS: "9",
      HARNESS_ROLLOVER_HANDOFF_MAX_TOKENS: "300",
      HARNESS_ROLLOVER_HANDOFF_PROMPT: "Write it.",
    });
    expect(view.effective.rolloverHandoff).toBe(false);
    expect(view.effective.rolloverHandoffThinkSeconds).toBe(5);
    expect(view.effective.rolloverHandoffTotalSeconds).toBe(9);
    expect(view.effective.rolloverHandoffMaxTokens).toBe(300);
    expect(view.effective.rolloverHandoffPrompt).toBe("Write it.");
    expect(view.overriddenByEnv.rolloverHandoff).toBe(
      "HARNESS_ROLLOVER_HANDOFF",
    );
  });

  it("refuses values the schema does not allow", () => {
    t = tempDatabase();
    const db = t.db;
    expect(() =>
      readSettings(db, { HARNESS_ROLLOVER_HANDOFF: "maybe" }),
    ).toThrow(/HARNESS_ROLLOVER_HANDOFF/);
    expect(() =>
      readSettings(db, { HARNESS_ROLLOVER_HANDOFF_THINK_SECONDS: "0" }),
    ).toThrow(/HARNESS_ROLLOVER_HANDOFF_THINK_SECONDS/);
  });
});

describe("requestHandoff", () => {
  it("returns the trimmed note and the last usage", async () => {
    const model = new ScriptedModel([
      [
        { type: "text", text: "  The " },
        { type: "text", text: "note.\n" },
        { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } },
        { type: "usage", usage: { promptTokens: 11, completionTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const result = await requestHandoff(
      model,
      input(),
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: true,
      note: "The note.",
      usage: { promptTokens: 11, completionTokens: 3 },
    });
  });

  it("builds the request: system, history, instruction last", async () => {
    const model = new ScriptedModel([say("n")]);
    await requestHandoff(
      model,
      input({
        system: "BASE",
        tools: [tool],
        model: "m1",
        reasoningEffort: "low",
        maxTokens: 123,
      }),
      new AbortController().signal,
    );
    const request = sent(model);
    expect(request.messages).toEqual([
      { role: "system", content: "BASE" },
      { role: "user", content: "hello" },
      { role: "user", content: "WRITE THE NOTE" },
    ]);
    expect(request.tools).toEqual([tool]);
    expect(request.control).toBeDefined();
    expect(request.sampling).toEqual({ maxTokens: 123 });
    expect(request.model).toBe("m1");
    expect(request.reasoningEffort).toBe("low");
  });

  it("leaves out the system message, tools, model and effort when there are none", async () => {
    const model = new ScriptedModel([say("n")]);
    await requestHandoff(
      model,
      input({ tools: [] }),
      new AbortController().signal,
    );
    const request = sent(model);
    expect(request.messages[0]).toEqual({ role: "user", content: "hello" });
    expect("tools" in request).toBe(false);
    expect("model" in request).toBe(false);
    expect("reasoningEffort" in request).toBe(false);
  });

  const failures: [string, ScriptStep[], string][] = [
    [
      "no text",
      [{ type: "finish", reason: "stop" }],
      "the model returned no text",
    ],
    ["only whitespace", say(" \n "), "the model returned no text"],
    [
      "a tool call",
      [
        { type: "text", text: "x" },
        {
          type: "tool_call",
          callId: "1",
          name: "current_date",
          arguments: "{}",
        },
      ],
      "the model called a tool",
    ],
    [
      "the token limit",
      [...say("cut"), { type: "finish", reason: "length" }],
      "the note was cut off at the token limit",
    ],
    ["a thrown error", [{ type: "throw", message: "boom" }], "boom"],
  ];
  it.each(failures)("fails on %s", async (_name, script, reason) => {
    const result = await requestHandoff(
      new ScriptedModel([script]),
      input(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("gives up when the total time is used", async () => {
    const result = await requestHandoff(
      new ScriptedModel([[{ type: "wait", until: never() }, ...say("late")]]),
      input({ totalMs: 30 }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "timed out" });
  });

  it("ends with 'stopped' when the caller's signal aborts", async () => {
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const result = await requestHandoff(
      new ScriptedModel([[{ type: "wait", until: never() }]]),
      input(),
      caller.signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "stopped" });
  });

  it("ends with 'stopped' when the signal was aborted before the call", async () => {
    const caller = new AbortController();
    caller.abort();
    const result = await requestHandoff(
      new ScriptedModel([say("never read")]),
      input(),
      caller.signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "stopped" });
  });

  /** A model whose response can be controlled, recording each stop-thinking. */
  const controllable = (inner: ScriptedModel, release: () => void) => {
    const calls: number[] = [];
    const model: ModelAdapter = {
      stream(
        request: ModelRequest,
        signal: AbortSignal,
      ): AsyncIterable<ModelChunk> {
        if (request.kind === "chat") {
          request.control?.bindEndReasoning(async () => {
            calls.push(Date.now());
            release();
            return { ok: true };
          });
        }
        return inner.stream(request, signal);
      },
    };
    return { model, calls };
  };

  it("sends stop-thinking once, after the first reasoning, then uses the note", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const { model, calls } = controllable(
      new ScriptedModel([
        [
          { type: "reasoning", text: "hmm" },
          { type: "reasoning", text: "still hmm" },
          { type: "wait", until: released },
          ...say("NOTE"),
        ],
      ]),
      () => release(),
    );
    const result = await requestHandoff(
      model,
      input({ thinkMs: 20, totalMs: 2000 }),
      new AbortController().signal,
    );
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, note: "NOTE" });
  });

  it("does not send stop-thinking when no reasoning arrives", async () => {
    const { model, calls } = controllable(
      new ScriptedModel([[{ type: "wait", until: sleep(60) }, ...say("NOTE")]]),
      () => {},
    );
    const result = await requestHandoff(
      model,
      input({ thinkMs: 10, totalMs: 2000 }),
      new AbortController().signal,
    );
    await sleep(20);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, note: "NOTE" });
  });

  it("reports what stop-thinking answered when the call then fails", async () => {
    // A plain ScriptedModel binds nothing, so stop-thinking is refused.
    const result = await requestHandoff(
      new ScriptedModel([
        [
          { type: "reasoning", text: "hmm" },
          { type: "wait", until: never() },
        ],
      ]),
      input({ thinkMs: 10, totalMs: 80 }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timed out");
      expect(result.stopThinking?.ok).toBe(false);
      expect(result.stopThinking?.message).toBeTruthy();
    }
  });

  it("has no stop-thinking answer when it was never sent", async () => {
    const result = await requestHandoff(
      new ScriptedModel([[{ type: "throw", message: "boom" }]]),
      input(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, stopThinking: null });
  });
});

const run = (over: Partial<RunRow>): RunRow => ({
  id: "r",
  session_id: "s",
  kind: "loop",
  status: "finished",
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
  usage: null,
  error: null,
  model: null,
  reasoning_effort: null,
  agent_id: null,
  agent_version: null,
  parent_run_id: null,
  parent_call_id: null,
  system_prompt: null,
  tools: null,
  skill_versions: null,
  ...over,
});

describe("recordedRequest and lastRecordedRun", () => {
  it("picks the newest top-level run that recorded a prompt or tools", () => {
    const runs = [
      run({ id: "a", system_prompt: "OLD" }),
      run({ id: "b", system_prompt: "NEW", tools: "[]" }),
      run({ id: "c" }),
    ];
    expect(lastRecordedRun(runs)?.id).toBe("b");
  });

  it("skips subagent runs", () => {
    const runs = [
      run({ id: "a", system_prompt: "TOP" }),
      run({ id: "b", system_prompt: "CHILD", parent_run_id: "a" }),
    ];
    expect(lastRecordedRun(runs)?.id).toBe("a");
  });

  it("finds nothing when no run recorded anything", () => {
    expect(lastRecordedRun([run({ id: "a" })])).toBeUndefined();
    expect(lastRecordedRun([])).toBeUndefined();
  });

  it("reads the system prompt and the tools", () => {
    expect(
      recordedRequest(
        run({ system_prompt: "BASE", tools: JSON.stringify([tool]) }),
      ),
    ).toEqual({ system: "BASE", tools: [tool] });
  });

  it("leaves tools out when the JSON cannot be read or is not a tool list", () => {
    expect(
      recordedRequest(run({ system_prompt: "B", tools: "{oops" })),
    ).toEqual({
      system: "B",
    });
    expect(recordedRequest(run({ tools: '[{"name":1}]' }))).toEqual({});
    expect(recordedRequest(run({ tools: "[]" }))).toEqual({});
  });

  it("gives nothing for a run that recorded neither, or no run", () => {
    expect(recordedRequest(run({}))).toEqual({});
    expect(recordedRequest(undefined)).toEqual({});
  });
});
