import { describe, expect, it } from "vitest";
import { HarnessEvent } from "./events.js";
import { ScriptedModel, type ScriptStep } from "./fake-model.js";
import type { ChatRequest } from "./model.js";
import { runSingleCall, type RunContext } from "./run.js";

const request: ChatRequest = {
  kind: "chat",
  model: "test-model",
  messages: [{ role: "user", content: "Hi" }],
};

function setup(script: ScriptStep[], signal = new AbortController().signal) {
  const events: HarnessEvent[] = [];
  let n = 0;
  const ctx: RunContext = {
    runId: "run-1",
    sessionId: "session-1",
    emit: (e) => events.push(e),
    signal,
    now: () => "2026-10-31T00:00:00.000Z",
    newId: () => `id-${++n}`,
  };
  const model = new ScriptedModel([script]);
  return { events, ctx, model };
}

const types = (events: HarnessEvent[]) => events.map((e) => e.type);

describe("runSingleCall", () => {
  it("streams text and ends with the authoritative message", async () => {
    const { events, ctx, model } = setup([
      { type: "text", text: "Hel" },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 1 } },
      { type: "text", text: "lo" },
      { type: "finish", reason: "stop" },
    ]);

    const result = await runSingleCall(model, request, ctx);

    expect(types(events)).toEqual([
      "run.started",
      "message.started",
      "text.delta",
      "text.delta",
      "text.end",
      "message.finished",
      "run.finished",
    ]);
    expect(events[4]).toMatchObject({
      type: "text.end",
      data: { messageId: "id-1", contentIndex: 0, text: "Hello" },
    });
    // Usage is cumulative and rides on deltas after it is known.
    expect(events[2]?.data).not.toHaveProperty("usage");
    expect(events[3]).toMatchObject({
      data: { usage: { promptTokens: 5, completionTokens: 1 } },
    });
    expect(result.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(model.requests).toEqual([request]);
  });

  it("emits only events that match the contract schema", async () => {
    const { events, ctx, model } = setup([
      { type: "reasoning", text: "think" },
      {
        type: "text",
        text: "a",
        tokens: [{ id: 64, text: "a", logprob: -0.1 }],
      },
      { type: "tool_call", callId: "c1", name: "t", arguments: '{"x":1}' },
      { type: "finish", reason: "tool_calls" },
    ]);
    await runSingleCall(model, request, ctx);
    for (const e of events) expect(HarnessEvent.parse(e)).toEqual(e);
  });

  it("gives each block its own contentIndex and closes it on switch", async () => {
    const { events, ctx, model } = setup([
      { type: "reasoning", text: "Let me " },
      { type: "reasoning", text: "think." },
      { type: "text", text: "Answer" },
    ]);

    const result = await runSingleCall(model, request, ctx);

    expect(types(events).slice(2, 6)).toEqual([
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.end",
      "text.delta",
    ]);
    expect(events[4]).toMatchObject({
      data: { contentIndex: 0, text: "Let me think." },
    });
    expect(events[5]).toMatchObject({ data: { contentIndex: 1 } });
    expect(result.message.content).toEqual([
      { type: "reasoning", text: "Let me think." },
      { type: "text", text: "Answer" },
    ]);
  });

  it("passes token data through on text deltas", async () => {
    const tokens = [
      {
        id: 9,
        text: "Hi",
        logprob: -0.2,
        top: [{ id: 9, text: "Hi", logprob: -0.2 }],
      },
    ];
    const { events, ctx, model } = setup([
      { type: "text", text: "Hi", tokens },
    ]);
    await runSingleCall(model, request, ctx);
    expect(events.find((e) => e.type === "text.delta")?.data).toMatchObject({
      tokens,
    });
  });

  it("reports tool calls and separates malformed ones", async () => {
    const { events, ctx, model } = setup([
      { type: "text", text: "Calling" },
      {
        type: "tool_call",
        callId: "c1",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
      { type: "tool_call", callId: "c2", name: "lookup", arguments: "{bad" },
      { type: "tool_call", callId: "c3", name: "now", arguments: "" },
      { type: "finish", reason: "tool_calls" },
    ]);

    const result = await runSingleCall(model, request, ctx);

    expect(types(events)).toEqual([
      "run.started",
      "message.started",
      "text.delta",
      "text.end",
      "tool.called",
      "tool.malformed",
      "tool.called",
      "message.finished",
      "run.finished",
    ]);
    expect(result.message.content).toEqual([
      { type: "text", text: "Calling" },
      {
        type: "tool_call",
        callId: "c1",
        name: "lookup",
        arguments: { q: "x" },
      },
      { type: "tool_call", callId: "c3", name: "now", arguments: {} },
    ]);
    expect(events[4]).toMatchObject({ data: { contentIndex: 1 } });
    expect(events[6]).toMatchObject({ data: { contentIndex: 2 } });
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toMatchObject({ callId: "c2", name: "lookup" });
    expect(result.finishReason).toBe("tool_calls");
  });

  it("keeps partial text and fails the run when the model errors", async () => {
    const { events, ctx, model } = setup([
      { type: "text", text: "Partial" },
      { type: "throw", message: "connection reset" },
    ]);

    const result = await runSingleCall(model, request, ctx);

    expect(types(events).slice(-3)).toEqual([
      "text.end",
      "message.finished",
      "run.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      data: { error: "connection reset" },
    });
    expect(result.finishReason).toBe("error");
    expect(result.message.content).toEqual([{ type: "text", text: "Partial" }]);
  });

  it("keeps partial text when cancelled", async () => {
    const controller = new AbortController();
    const { events, ctx, model } = setup(
      [
        { type: "text", text: "Once upon" },
        { type: "wait", until: new Promise(() => {}) },
        { type: "text", text: " a time" },
      ],
      controller.signal,
    );
    let firstDelta!: () => void;
    const sawDelta = new Promise<void>((r) => (firstDelta = r));
    const emit = ctx.emit;
    ctx.emit = (e) => {
      emit(e);
      if (e.type === "text.delta") firstDelta();
    };

    const running = runSingleCall(model, request, ctx);
    await sawDelta;
    controller.abort();
    const result = await running;

    expect(result.finishReason).toBe("cancelled");
    expect(result.message.content).toEqual([
      { type: "text", text: "Once upon" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      data: { reason: "cancelled" },
    });
  });

  it("reports the model on run.started", async () => {
    const { events, ctx, model } = setup([{ type: "text", text: "x" }]);
    await runSingleCall(model, request, ctx);
    expect(events[0]).toMatchObject({
      type: "run.started",
      data: { kind: "single", model: "test-model" },
    });
  });

  it("reports the reasoning effort on run.started", async () => {
    const { events, ctx, model } = setup([{ type: "text", text: "x" }]);
    await runSingleCall(model, { ...request, reasoningEffort: "low" }, ctx);
    expect(events[0]).toMatchObject({
      data: { model: "test-model", reasoningEffort: "low" },
    });
  });

  it("reports the agent on run.started, and checks its shape", async () => {
    const { events, ctx, model } = setup([{ type: "text", text: "x" }]);
    const agent = { id: "a1", name: "Editor", version: 3, projectId: null };
    await runSingleCall(model, request, { ...ctx, agent });
    expect(events[0]).toMatchObject({
      type: "run.started",
      data: { kind: "single", agent },
    });
    expect(HarnessEvent.safeParse(events[0]).success).toBe(true);
    expect(
      HarnessEvent.safeParse({
        ...events[0],
        data: { kind: "single", agent: { id: "a1" } },
      }).success,
    ).toBe(false);
  });

  it("records the parent run when nested", async () => {
    const { events, ctx, model } = setup([{ type: "text", text: "x" }]);
    await runSingleCall(model, request, { ...ctx, parentRunId: "run-0" });
    expect(events[0]).toMatchObject({
      type: "run.started",
      data: { kind: "single", parentRunId: "run-0" },
    });
  });
});

describe("event schema", () => {
  it("rejects an event with a wrong data shape", () => {
    const bad = {
      runId: "r",
      sessionId: "s",
      time: "t",
      type: "text.delta",
      data: { messageId: "m", text: "x" },
    };
    expect(HarnessEvent.safeParse(bad).success).toBe(false);
  });
});
