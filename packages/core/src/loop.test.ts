import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HarnessEvent,
  type ApprovalAnswer,
  type ApprovalChoice,
  type InputRequest,
} from "./events.js";
import type { Form, InputAnswer } from "./forms.js";
import { ScriptedModel, type ScriptStep } from "./fake-model.js";
import {
  runLoop,
  type ApprovalRequest,
  type LoopContext,
  type ToolErrorReport,
} from "./loop.js";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "./messages.js";
import type { ChatRequest } from "./model.js";
import { FakeSharedEntries } from "./fake-shared-entries.js";
import { buildMessageContent } from "./message-state.js";
import { ASK_USER, DECLINED } from "./forms.js";
import { defineTool, ToolError, ToolRunError, type Tool } from "./tools.js";

const request: ChatRequest = {
  kind: "chat",
  model: "m",
  messages: [{ role: "user", content: "Hi" }],
};

const echo = defineTool({
  name: "echo",
  description: "Echoes its text.",
  input: z.object({ text: z.string() }),
  approval: "never",
  group: "utilities" as const,
  execute: (input) => ({ data: { echoed: input.text } }),
});

const call = (callId: string, name: string, args: string): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: args,
});

function setup(
  scripts: ScriptStep[][],
  extra: Partial<LoopContext> = {},
  signal = new AbortController().signal,
) {
  const events: HarnessEvent[] = [];
  const saved: {
    id: string;
    message: AssistantMessage | ToolResultMessage | UserMessage;
  }[] = [];
  const approvals: ApprovalRequest[] = [];
  let n = 0;
  const ctx: LoopContext = {
    runId: "run-1",
    sessionId: "s-1",
    emit: (e) => events.push(e),
    signal,
    now: () => "T",
    newId: () => `id-${++n}`,
    tools: [echo],
    maxIterations: 5,
    approve: (r) => {
      approvals.push(r);
      return Promise.resolve({ choice: "once" });
    },
    onMessage: (id, message) => {
      // Saved before its event: no event for this message yet.
      const eventFor = events.some(
        (e) =>
          (e.type === "message.finished" && e.data.messageId === id) ||
          (e.type === "tool.result" && e.data.messageId === id),
      );
      expect(eventFor).toBe(false);
      saved.push({ id, message });
    },
    ...extra,
  };
  const model = new ScriptedModel(scripts);
  return { events, saved, approvals, ctx, model };
}

const types = (events: HarnessEvent[]) => events.map((e) => e.type);
const results = (saved: { message: Message }[]) =>
  saved
    .map((s) => s.message)
    .filter((m): m is ToolResultMessage => m.role === "tool");

describe("runLoop", () => {
  it("reports the agent on run.started", async () => {
    const { events, ctx, model } = setup([[{ type: "text", text: "x" }]]);
    const agent = { id: "a1", name: "Editor", version: 2, projectId: "p" };
    await runLoop(model, request, { ...ctx, agent });
    expect(events[0]).toMatchObject({
      type: "run.started",
      data: { kind: "loop", agent },
    });
  });

  it("runs a tool, sends the result back, and stops when the model does", async () => {
    const { events, saved, ctx, model } = setup([
      [
        call("c1", "echo", '{"text":"hi"}'),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "Done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const result = await runLoop(model, request, ctx);

    expect(result.reason).toBe("stop");
    expect(types(events)).toEqual([
      "run.started",
      "step.started",
      "message.started",
      "tool.called",
      "message.finished",
      "tool.result",
      "step.finished",
      "step.started",
      "message.started",
      "text.delta",
      "text.end",
      "message.finished",
      "step.finished",
      "run.finished",
    ]);
    expect(events[0]).toMatchObject({ data: { kind: "loop", model: "m" } });
    for (const e of events) expect(HarnessEvent.parse(e)).toEqual(e);

    expect(saved.map((s) => s.message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(results(saved)[0]).toEqual({
      role: "tool",
      callId: "c1",
      name: "echo",
      content: '{"echoed":"hi"}',
      isError: false,
      data: { echoed: "hi" },
    });
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult?.data).toMatchObject({
      messageId: saved[1]?.id,
      callId: "c1",
      name: "echo",
      isError: false,
      preview: '{"echoed":"hi"}',
    });

    // The second request carries the tools and the whole exchange.
    const second = model.requests[1] as ChatRequest;
    expect(second.tools?.map((t) => t.name)).toEqual(["echo"]);
    expect(second.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("stops at the iteration limit", async () => {
    const loopForever = [
      call("c", "echo", '{"text":"x"}'),
      { type: "finish", reason: "tool_calls" },
    ] satisfies ScriptStep[];
    const { events, ctx, model } = setup(
      [loopForever, loopForever, loopForever],
      {
        maxIterations: 2,
      },
    );
    const result = await runLoop(model, request, ctx);
    expect(result.reason).toBe("iteration_limit");
    expect(model.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      data: { reason: "iteration_limit" },
    });
  });

  it("sums usage over the steps", async () => {
    const { events, ctx, model } = setup([
      [
        call("c1", "echo", '{"text":"a"}'),
        { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } },
      ],
      [
        { type: "text", text: "ok" },
        { type: "usage", usage: { promptTokens: 20, completionTokens: 3 } },
      ],
    ]);
    const result = await runLoop(model, request, ctx);
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 5 });
    expect(events.at(-1)).toMatchObject({
      data: { usage: { promptTokens: 30, completionTokens: 5 } },
    });
  });

  it("hands each assistant message its own call's usage", async () => {
    const got: { id: string; role: string; usage: unknown }[] = [];
    const { ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } },
        ],
        [
          { type: "text", text: "ok" },
          { type: "usage", usage: { promptTokens: 20, completionTokens: 3 } },
        ],
      ],
      {
        onMessage: (id, message, usage) =>
          got.push({ id, role: message.role, usage }),
      },
    );
    await runLoop(model, request, ctx);
    expect(got).toEqual([
      {
        id: "id-1",
        role: "assistant",
        usage: { promptTokens: 10, completionTokens: 2 },
      },
      { id: "id-2", role: "tool", usage: undefined },
      {
        id: "id-3",
        role: "assistant",
        usage: { promptTokens: 20, completionTokens: 3 },
      },
    ]);
  });

  it("returns unknown tools, bad JSON and failed checks to the model", async () => {
    const { events, saved, ctx, model } = setup([
      [
        call("c1", "nope", "{}"),
        call("c2", "echo", "{bad"),
        call("c3", "echo", '{"text":5}'),
      ],
      [{ type: "text", text: "sorry" }],
    ]);

    const result = await runLoop(model, request, ctx);

    expect(result.reason).toBe("stop");
    const r = results(saved);
    expect(r.map((m) => [m.callId, m.isError])).toEqual([
      ["c1", true],
      ["c2", true],
      ["c3", true],
    ]);
    expect(r[0]?.content).toBe('Unknown tool "nope".');
    expect(r[1]?.content).toMatch(/^Invalid JSON in tool arguments/);
    expect(r[2]?.content).toMatch(/^Invalid arguments for echo:/);

    // The malformed call stays in the message with its raw arguments, so
    // the model sees the call its error answers.
    const first = saved[0]?.message as AssistantMessage;
    expect(first.content[1]).toEqual({
      type: "tool_call",
      callId: "c2",
      name: "echo",
      arguments: "{bad",
    });
    expect(buildMessageContent(events.slice(0, 6), saved[0]?.id ?? "")).toEqual(
      first.content,
    );
  });

  it("does not run calls from a response cut off at the token limit", async () => {
    let ran = false;
    const tool = defineTool({
      ...echoSpec,
      execute: () => {
        ran = true;
        return { data: "x" };
      },
    });
    const { saved, ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          { type: "finish", reason: "length" },
        ],
        [{ type: "text", text: "ok" }],
      ],
      { tools: [tool] },
    );
    await runLoop(model, request, ctx);
    expect(ran).toBe(false);
    expect(results(saved)[0]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/token limit/) as unknown,
    });
    expect(model.requests).toHaveLength(2);
  });

  it("returns thrown errors to the model, shortened, with the full text in the event", async () => {
    const long = "x".repeat(50);
    const failing = defineTool({
      ...echoSpec,
      execute: () => {
        throw new Error(long);
      },
    });
    const { events, saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { tools: [failing], errorLimit: 20, previewLimit: 10 },
    );
    const result = await runLoop(model, request, ctx);
    expect(result.reason).toBe("stop");
    const content = results(saved)[0]?.content ?? "";
    expect(content.startsWith("echo failed: xxxxxxx")).toBe(true);
    expect(content).toMatch(/more characters\]$/);
    const e = events.find((x) => x.type === "tool.result");
    expect(e?.data).toMatchObject({
      isError: true,
      error: `echo failed: ${long}`,
      preview: expect.stringMatching(/^echo faile… /) as unknown,
    });
  });

  it("returns a result marked as an error and continues", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: () => ({ data: { problem: "no" }, isError: true }),
    });
    const { saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { tools: [tool] },
    );
    expect((await runLoop(model, request, ctx)).reason).toBe("stop");
    expect(results(saved)[0]).toMatchObject({
      isError: true,
      content: '{"problem":"no"}',
      data: { problem: "no" },
    });
  });

  it("fails the run on ToolRunError and answers every call", async () => {
    const fatal = defineTool({
      ...echoSpec,
      execute: () => {
        throw new ToolRunError("cannot go on");
      },
    });
    const { events, saved, ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          call("c2", "echo", '{"text":"b"}'),
        ],
      ],
      { tools: [fatal] },
    );
    const result = await runLoop(model, request, ctx);
    expect(result).toMatchObject({ reason: "failed", error: "cannot go on" });
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: "cannot go on" },
    });
    expect(results(saved).map((r) => [r.callId, r.content])).toEqual([
      ["c1", "cannot go on"],
      ["c2", "Not run: the run failed."],
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("runs several calls in order", async () => {
    const order: string[] = [];
    const slow = defineTool({
      ...echoSpec,
      execute: async (input) => {
        order.push(`start ${input.text}`);
        await new Promise((r) => setTimeout(r, input.text === "a" ? 20 : 0));
        order.push(`end ${input.text}`);
        return { data: input.text };
      },
    });
    const { ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          call("c2", "echo", '{"text":"b"}'),
        ],
        [{ type: "text", text: "ok" }],
      ],
      { tools: [slow] },
    );
    await runLoop(model, request, ctx);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("gives a tool its latest state and saves the new one", async () => {
    const seen: unknown[] = [];
    const counter = defineTool({
      name: "count",
      description: "Counts calls.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: (_input, ctx) => {
        seen.push(ctx.state);
        const next = ((ctx.state as number | undefined) ?? 0) + 1;
        return { data: next, state: next };
      },
    });
    const earlier: Message = {
      role: "tool",
      callId: "old",
      name: "count",
      content: "5",
      isError: false,
      state: 5,
    };
    const { saved, ctx, model } = setup(
      [
        [call("c1", "count", "{}")],
        [call("c2", "count", "{}")],
        [{ type: "text", text: "ok" }],
      ],
      { tools: [counter] },
    );
    await runLoop(
      model,
      { ...request, messages: [...request.messages, earlier] },
      ctx,
    );
    expect(seen).toEqual([5, 6]);
    expect(results(saved).map((r) => r.state)).toEqual([6, 7]);
    // State is not part of what the model reads.
    expect(results(saved)[0]?.content).toBe("6");
  });

  it("reports progress as tool.update", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: (_i, ctx) => {
        ctx.update("half");
        return { data: "done" };
      },
    });
    const { events, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { tools: [tool] },
    );
    await runLoop(model, request, ctx);
    expect(events.find((e) => e.type === "tool.update")).toMatchObject({
      data: { callId: "c1", partial: "half" },
    });
  });

  it("continues an existing message, then runs the tools it calls", async () => {
    const existing: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Let me" }],
    };
    const { saved, ctx, model } = setup(
      [
        [{ type: "text", text: " check." }, call("c1", "echo", '{"text":"a"}')],
        [{ type: "text", text: "ok" }],
      ],
      { continueMessage: { messageId: "old", message: existing } },
    );
    await runLoop(
      model,
      { ...request, messages: [...request.messages, existing] },
      ctx,
    );
    expect(saved[0]).toEqual({
      id: "old",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            callId: "c1",
            name: "echo",
            arguments: { text: "a" },
          },
        ],
      },
    });
    const second = model.requests[1] as ChatRequest;
    expect(second.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("fails the run when the model errors, answering calls it made", async () => {
    const { events, saved, ctx, model } = setup([
      [call("c1", "echo", '{"text":"a"}'), { type: "throw", message: "reset" }],
    ]);
    const result = await runLoop(model, request, ctx);
    expect(result).toMatchObject({ reason: "failed", error: "reset" });
    expect(results(saved)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
  });
});

const echoSpec = {
  name: "echo",
  description: "Echoes its text.",
  input: z.object({ text: z.string() }),
  approval: "never" as const,
  group: "utilities" as const,
};

describe("a tool that always asks", () => {
  const fixed = (run: () => void = () => {}): Tool =>
    defineTool({
      ...echoSpec,
      approval: "always",
      group: "utilities" as const,
      execute: (input) => {
        run();
        return { data: input.text };
      },
    });

  it("asks without needsApproval and marks the request", async () => {
    let ran = false;
    const { events, approvals, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { tools: [fixed(() => (ran = true))] },
    );
    await runLoop(model, request, ctx);
    expect(ran).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ name: "echo", alwaysAsks: true });
    expect(
      events.find((e) => e.type === "tool.approval_requested")?.data,
    ).toMatchObject({ alwaysAsks: true });
  });

  it("does not mark a request for a tool that can be switched off", async () => {
    const { events, approvals, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [
          defineTool({
            ...echoSpec,
            approval: "ask",
            group: "utilities" as const,
            execute: (input) => ({ data: input.text }),
          }),
        ],
      },
    );
    await runLoop(model, request, ctx);
    expect(approvals[0]).not.toHaveProperty("alwaysAsks");
    expect(
      events.find((e) => e.type === "tool.approval_requested")?.data,
    ).not.toHaveProperty("alwaysAsks");
  });

  it("is not marked as the agent's setting", async () => {
    const { events, approvals, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { tools: [fixed()], agentDecides: () => true },
    );
    await runLoop(model, request, ctx);
    expect(approvals[0]).not.toHaveProperty("agentSetting");
    expect(
      events.find((e) => e.type === "tool.approval_requested")?.data,
    ).not.toHaveProperty("agentSetting");
  });

  it("does not run when denied", async () => {
    let ran = false;
    const { ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [fixed(() => (ran = true))],
        approve: () => Promise.resolve({ choice: "deny" }),
      },
    );
    await runLoop(model, request, ctx);
    expect(ran).toBe(false);
  });
});

describe("approval", () => {
  const asking = (run: () => void = () => {}): Tool =>
    defineTool({
      ...echoSpec,
      approval: "ask",
      group: "utilities" as const,
      execute: (input) => {
        run();
        return { data: input.text };
      },
    });

  for (const choice of ["once", "session", "always"] as ApprovalChoice[]) {
    it(`runs the tool when the answer is "${choice}"`, async () => {
      let ran = false;
      const { events, approvals, saved, ctx, model } = setup(
        [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
        {
          tools: [asking(() => (ran = true))],
          approve: (r) => {
            approvals.push(r);
            return Promise.resolve({ choice });
          },
        },
      );
      await runLoop(model, request, ctx);
      expect(ran).toBe(true);
      expect(approvals).toEqual([
        {
          requestId: expect.any(String) as unknown,
          callId: "c1",
          name: "echo",
          arguments: { text: "a" },
        },
      ]);
      const requestId = approvals[0]?.requestId;
      const requested = events.findIndex(
        (e) => e.type === "tool.approval_requested",
      );
      expect(events[requested]?.data).toMatchObject({
        requestId,
        callId: "c1",
      });
      expect(events[requested + 1]).toMatchObject({
        type: "tool.approval_resolved",
        data: { requestId, choice },
      });
      expect(results(saved)[0]?.isError).toBe(false);
    });
  }

  it("returns a denied call to the model as an error and continues", async () => {
    let ran = false;
    const { saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [asking(() => (ran = true))],
        approve: () => Promise.resolve({ choice: "deny" }),
      },
    );
    const result = await runLoop(model, request, ctx);
    expect(ran).toBe(false);
    expect(result.reason).toBe("stop");
    expect(results(saved)[0]).toMatchObject({
      isError: true,
      content: "The user denied this tool call.",
    });
  });

  it('keeps a note given with "once" on the result and the event', async () => {
    const { events, saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [asking()],
        approve: () =>
          Promise.resolve({ choice: "once", note: "  keep it short \n" }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]).toMatchObject({
      isError: false,
      note: { text: "keep it short", choice: "once" },
    });
    expect(
      events.find((e) => e.type === "tool.approval_resolved")?.data,
    ).toMatchObject({ choice: "once", note: "keep it short" });
    // The next model call sees the result with its note.
    const next = model.requests[1];
    expect(next?.kind === "chat" ? next.messages.at(-1) : undefined).toEqual(
      results(saved)[0],
    );
  });

  it('keeps a note given with "deny" on the denied result', async () => {
    const { events, saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [asking()],
        approve: () => Promise.resolve({ choice: "deny", note: "try b" }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]).toMatchObject({
      isError: true,
      content: "The user denied this tool call.",
      note: { text: "try b", choice: "deny" },
    });
    expect(
      events.find((e) => e.type === "tool.approval_resolved")?.data,
    ).toMatchObject({ choice: "deny", note: "try b" });
  });

  for (const choice of ["session", "always"] as ApprovalChoice[]) {
    it(`drops a note given with "${choice}"`, async () => {
      const { events, saved, ctx, model } = setup(
        [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
        {
          tools: [asking()],
          approve: () => Promise.resolve({ choice, note: "x" }),
        },
      );
      await runLoop(model, request, ctx);
      expect(results(saved)[0]).not.toHaveProperty("note");
      expect(
        events.find((e) => e.type === "tool.approval_resolved")?.data,
      ).not.toHaveProperty("note");
    });
  }

  it("treats an empty or blank note as no note", async () => {
    const { events, saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      {
        tools: [asking()],
        approve: () => Promise.resolve({ choice: "once", note: " \n " }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]).not.toHaveProperty("note");
    expect(
      events.find((e) => e.type === "tool.approval_resolved")?.data,
    ).not.toHaveProperty("note");
  });

  it("keeps a note given earlier in a turn when the run is cancelled", async () => {
    const controller = new AbortController();
    let asked = 0;
    let second!: () => void;
    const secondAsked = new Promise<void>((r) => (second = r));
    const { saved, ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          call("c2", "echo", '{"text":"b"}'),
        ],
      ],
      {
        tools: [asking()],
        approve: () => {
          if (++asked === 1)
            return Promise.resolve({ choice: "deny", note: "not that" });
          second();
          return new Promise<ApprovalAnswer>(() => {});
        },
      },
      controller.signal,
    );
    const running = runLoop(model, request, ctx);
    await secondAsked;
    controller.abort();
    expect((await running).reason).toBe("cancelled");
    expect(results(saved)).toMatchObject([
      { callId: "c1", note: { text: "not that", choice: "deny" } },
      { callId: "c2", content: "Not run: the run was cancelled." },
    ]);
    expect(results(saved)[1]).not.toHaveProperty("note");
  });

  it("asks according to needsApproval, not only the tool's default", async () => {
    const { approvals, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')], [{ type: "text", text: "ok" }]],
      { needsApproval: () => true },
    );
    await runLoop(model, request, ctx);
    expect(approvals).toHaveLength(1);
  });

  it("waits for the answer, and withdraws the request on cancel", async () => {
    const controller = new AbortController();
    let asked!: () => void;
    const wasAsked = new Promise<void>((r) => (asked = r));
    const { events, saved, ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          call("c2", "echo", '{"text":"b"}'),
        ],
      ],
      {
        tools: [asking()],
        approve: () => {
          asked();
          return new Promise<ApprovalAnswer>(() => {});
        },
      },
      controller.signal,
    );
    const running = runLoop(model, request, ctx);
    await wasAsked;
    controller.abort();
    const result = await running;

    expect(result.reason).toBe("cancelled");
    const requested = events.find((e) => e.type === "tool.approval_requested");
    expect(events.find((e) => e.type === "request.cancel")).toMatchObject({
      data: {
        requestId:
          requested?.type === "tool.approval_requested"
            ? requested.data.requestId
            : "",
      },
    });
    expect(results(saved).map((r) => [r.callId, r.content])).toEqual([
      ["c1", "Not run: the run was cancelled."],
      ["c2", "Not run: the run was cancelled."],
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      data: { reason: "cancelled" },
    });
  });
});

describe("asking the user (input forms)", () => {
  const form: Form = {
    title: "Story",
    fields: [
      {
        name: "g",
        label: "Genre",
        required: true,
        kind: "text",
        multiline: false,
      },
    ],
  };
  /** Shows `form` and returns the answer as its result. */
  const asker = defineTool({
    name: "asker",
    description: "Asks.",
    input: z.object({}),
    approval: "never",
    group: "utilities" as const,
    execute: async (_i, ctx) => {
      const answer = await ctx.requestInput(form);
      return answer.outcome === "answered"
        ? { data: answer.answers }
        : { data: "skipped", isError: true };
    },
  });

  it("emits the request, waits for the answer, and resolves it", async () => {
    const requests: InputRequest[] = [];
    const { events, saved, ctx, model } = setup(
      [[call("c1", "asker", "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [asker],
        requestInput: (r) => {
          requests.push(r);
          return Promise.resolve<InputAnswer>({
            outcome: "answered",
            answers: { g: "noir" },
          });
        },
      },
    );
    await runLoop(model, request, ctx);
    expect(requests).toEqual([{ requestId: "id-2", callId: "c1", form }]);
    const relevant = events.filter((e) =>
      ["input.requested", "input.resolved", "tool.result"].includes(e.type),
    );
    expect(relevant.map((e) => [e.type, e.data])).toEqual([
      ["input.requested", { requestId: "id-2", callId: "c1", form }],
      ["input.resolved", { requestId: "id-2", outcome: "answered" }],
      [
        "tool.result",
        expect.objectContaining({ callId: "c1", isError: false }),
      ],
    ]);
    expect(results(saved)[0]?.content).toBe('{"g":"noir"}');
  });

  it("passes a skip to the tool", async () => {
    const { events, saved, ctx, model } = setup(
      [[call("c1", "asker", "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [asker],
        requestInput: () =>
          Promise.resolve<InputAnswer>({ outcome: "skipped" }),
      },
    );
    await runLoop(model, request, ctx);
    expect(events.find((e) => e.type === "input.resolved")?.data).toMatchObject(
      { outcome: "skipped" },
    );
    expect(results(saved)[0]).toMatchObject({
      content: "skipped",
      isError: true,
    });
  });

  it("withdraws the request on cancel; the call is not run", async () => {
    const controller = new AbortController();
    let asked!: () => void;
    const wasAsked = new Promise<void>((r) => (asked = r));
    const { events, saved, ctx, model } = setup(
      [[call("c1", "asker", "{}")]],
      {
        tools: [asker],
        requestInput: () => {
          asked();
          return new Promise<InputAnswer>(() => {});
        },
      },
      controller.signal,
    );
    const running = runLoop(model, request, ctx);
    await wasAsked;
    controller.abort();
    expect((await running).reason).toBe("cancelled");
    expect(events.find((e) => e.type === "request.cancel")?.data).toEqual({
      requestId: "id-2",
      reason: "The run was cancelled.",
    });
    expect(events.some((e) => e.type === "input.resolved")).toBe(false);
    expect(results(saved)[0]?.content).toBe("Not run: the run was cancelled.");
  });

  it("keeps a tool's form and answer with its result (tool prompts D9)", async () => {
    const labelled: Form = {
      title: "Save where?",
      fields: [
        {
          name: "scope",
          label: "Save to",
          required: true,
          noOther: true,
          kind: "choice",
          options: ["session", "global"],
          labels: { global: "Every conversation" },
        },
      ],
    };
    const saver = defineTool({
      name: "saver",
      description: "Saves.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: async (_i, ctx) => {
        await ctx.requestInput(labelled);
        return { data: "saved" };
      },
    });
    const { saved, ctx, model } = setup(
      [[call("c1", "saver", "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [saver],
        requestInput: () =>
          Promise.resolve<InputAnswer>({
            outcome: "answered",
            answers: { scope: "global" },
          }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]?.prompt).toEqual({
      title: "Save where?",
      answers: [{ question: "Save to", answer: "Every conversation" }],
    });
  });

  it("does not report a tool's error after its form was skipped", async () => {
    const reports: ToolErrorReport[] = [];
    const { saved, ctx, model } = setup(
      [[call("c1", "asker", "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [asker],
        requestInput: () =>
          Promise.resolve<InputAnswer>({ outcome: "skipped" }),
        reportError: (r) => reports.push(r),
      },
    );
    await runLoop(model, request, ctx);
    expect(reports).toEqual([]);
    expect(results(saved)[0]?.prompt).toEqual({
      title: "Story",
      answers: [],
      skipped: "Skip",
    });
  });

  it("lets a tool ask only once per call (tool prompts D10)", async () => {
    const twice = defineTool({
      name: "twice",
      description: "Asks twice.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: async (_i, ctx) => {
        await ctx.requestInput(form);
        await ctx.requestInput(form);
        return { data: "x" };
      },
    });
    const { saved, ctx, model } = setup(
      [[call("c1", "twice", "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [twice],
        requestInput: () =>
          Promise.resolve<InputAnswer>({
            outcome: "answered",
            answers: { g: "noir" },
          }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]).toMatchObject({
      content: "twice failed: A tool can ask the user only once per call.",
      isError: true,
      // The answered form is still kept.
      prompt: { answers: [{ answer: "noir" }] },
    });
  });

  it("does not keep ask_user forms as prompts; they are rebuilt from the call", async () => {
    const asking = defineTool({
      name: ASK_USER,
      description: "Asks.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: async (_i, ctx) => {
        await ctx.requestInput(form);
        return { data: "x" };
      },
    });
    const { saved, ctx, model } = setup(
      [[call("c1", ASK_USER, "{}")], [{ type: "text", text: "ok" }]],
      {
        tools: [asking],
        requestInput: () =>
          Promise.resolve<InputAnswer>({ outcome: "skipped" }),
      },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]).not.toHaveProperty("prompt");
  });

  it("fails the call when the run cannot ask", async () => {
    const { events, saved, ctx, model } = setup(
      [[call("c1", "asker", "{}")], [{ type: "text", text: "ok" }]],
      { tools: [asker] },
    );
    await runLoop(model, request, ctx);
    expect(events.some((e) => e.type === "input.requested")).toBe(false);
    expect(results(saved)[0]).toMatchObject({
      content: "asker failed: This run cannot ask the user for input.",
      isError: true,
    });
  });
});

describe("cancelling", () => {
  it("aborts a running tool through its signal", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const isRunning = new Promise<void>((r) => (started = r));
    const waiting = defineTool({
      ...echoSpec,
      execute: (_i, ctx) =>
        new Promise((_resolve, reject) => {
          started();
          ctx.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    });
    const { saved, ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')]],
      { tools: [waiting] },
      controller.signal,
    );
    const running = runLoop(model, request, ctx);
    await isRunning;
    controller.abort();
    expect((await running).reason).toBe("cancelled");
    expect(results(saved)[0]?.content).toBe("Not run: the run was cancelled.");
    expect(model.requests).toHaveLength(1);
  });
});

describe("reporting errors (error reporting plan, P2)", () => {
  /** Runs one call of `tool`, collecting what is reported. */
  async function reportsFor(
    tool: Tool,
    args = '{"text":"a"}',
    extra: Partial<LoopContext> = {},
  ) {
    const reports: ToolErrorReport[] = [];
    const { saved, ctx, model } = setup(
      [[call("c1", tool.name, args)], [{ type: "text", text: "ok" }]],
      { tools: [tool], reportError: (r) => reports.push(r), ...extra },
    );
    const result = await runLoop(model, request, ctx);
    return { reports, saved, result };
  }

  it("reports a ToolError with its details, stack and arguments", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: () => {
        throw new ToolError("HTTP 404 Not Found", {
          details: { status: 404 },
        });
      },
    });
    const { reports, saved } = await reportsFor(tool);
    const stored = saved.find((s) => s.message.role === "tool");
    expect(reports).toEqual([
      {
        kind: "tool_threw",
        callId: "c1",
        toolName: "echo",
        messageId: stored?.id,
        message: "echo failed: HTTP 404 Not Found",
        details: { status: 404 },
        stack: expect.stringContaining("HTTP 404 Not Found") as unknown,
        arguments: { text: "a" },
        endsRun: false,
      },
    ]);
    // The model gets the message only; the details stay out of it.
    expect(stored?.message).toMatchObject({
      content: "echo failed: HTTP 404 Not Found",
      isError: true,
    });
    expect(JSON.stringify(stored?.message)).not.toContain("404}");
  });

  it("reports any thrown error, without details", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: () => {
        throw new TypeError("boom");
      },
    });
    const { reports } = await reportsFor(tool);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "tool_threw",
      message: "echo failed: boom",
      stack: expect.stringContaining("TypeError: boom") as unknown,
    });
    expect(reports[0]).not.toHaveProperty("details");
  });

  it("reports a returned error in full, with its details", async () => {
    const long = "x".repeat(50);
    const tool = defineTool({
      ...echoSpec,
      execute: () => ({
        data: { error: long },
        isError: true,
        details: { key: "k" },
      }),
    });
    const { reports, saved } = await reportsFor(tool, '{"text":"a"}', {
      errorLimit: 10,
    });
    expect(reports).toEqual([
      expect.objectContaining({
        kind: "tool_returned_error",
        message: JSON.stringify({ error: long }),
        details: { key: "k" },
        arguments: { text: "a" },
        endsRun: false,
      }),
    ]);
    expect(reports[0]).not.toHaveProperty("stack");
    expect(results(saved)[0]?.content).toMatch(/more characters/);
  });

  it("ignores details on a result that is not an error", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: () => ({ data: "fine", details: { x: 1 } }),
    });
    const { reports } = await reportsFor(tool);
    expect(reports).toEqual([]);
  });

  it("reports unknown tools, malformed calls and invalid arguments", async () => {
    const reports: ToolErrorReport[] = [];
    const { ctx, model } = setup(
      [
        [
          call("c1", "nope", "{}"),
          call("c2", "echo", "{bad"),
          call("c3", "echo", '{"text":5}'),
        ],
        [{ type: "text", text: "sorry" }],
      ],
      { reportError: (r) => reports.push(r) },
    );
    await runLoop(model, request, ctx);
    expect(reports.map((r) => [r.kind, r.callId, r.arguments])).toEqual([
      ["unknown_tool", "c1", {}],
      ["malformed_call", "c2", "{bad"],
      ["invalid_arguments", "c3", { text: 5 }],
    ]);
    expect(reports[0]?.message).toBe('Unknown tool "nope".');
    expect(reports[2]?.message).toMatch(/^Invalid arguments for echo:/);
  });

  it("reports a ToolRunError as ending the run, unprefixed", async () => {
    const tool = defineTool({
      ...echoSpec,
      execute: () => {
        throw new ToolRunError("cannot go on", { details: { why: "x" } });
      },
    });
    const { reports, result } = await reportsFor(tool);
    expect(result).toMatchObject({ reason: "failed", error: "cannot go on" });
    expect(reports).toEqual([
      expect.objectContaining({
        kind: "tool_threw",
        message: "cannot go on",
        details: { why: "x" },
        endsRun: true,
      }),
    ]);
  });

  it("does not report a denied call", async () => {
    const tool = defineTool({
      ...echoSpec,
      approval: "ask",
      group: "utilities" as const,
      execute: () => ({ data: "x" }),
    });
    const { reports } = await reportsFor(tool, '{"text":"a"}', {
      approve: () => Promise.resolve({ choice: "deny" }),
    });
    expect(reports).toEqual([]);
  });

  it("does not report calls cut off at the token limit", async () => {
    const reports: ToolErrorReport[] = [];
    const { ctx, model } = setup(
      [
        [
          call("c1", "echo", '{"text":"a"}'),
          { type: "finish", reason: "length" },
        ],
        [{ type: "text", text: "ok" }],
      ],
      { reportError: (r) => reports.push(r) },
    );
    await runLoop(model, request, ctx);
    expect(reports).toEqual([]);
  });

  it("does not report a call stopped by cancelling", async () => {
    const controller = new AbortController();
    const tool = defineTool({
      ...echoSpec,
      execute: (_i, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
          controller.abort();
        }),
    });
    const reports: ToolErrorReport[] = [];
    const { ctx, model } = setup(
      [[call("c1", "echo", '{"text":"a"}')]],
      { tools: [tool], reportError: (r) => reports.push(r) },
      controller.signal,
    );
    expect((await runLoop(model, request, ctx)).reason).toBe("cancelled");
    expect(reports).toEqual([]);
  });

  it("does not report a declined ask_user form, but reports its other errors", async () => {
    const declining = defineTool({
      name: ASK_USER,
      description: "Asks.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: () => ({ data: DECLINED, isError: true }),
    });
    expect((await reportsFor(declining, "{}")).reports).toEqual([]);

    // Other ask_user errors (a form that could not be shown) are reported.
    const bad = defineTool({
      name: ASK_USER,
      description: "Asks.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: () => ({ data: "The form was not shown", isError: true }),
    });
    expect((await reportsFor(bad, "{}")).reports).toEqual([
      expect.objectContaining({ kind: "tool_returned_error" }),
    ]);

    const asking = defineTool({
      name: ASK_USER,
      description: "Asks.",
      input: z.object({}),
      approval: "never",
      group: "utilities" as const,
      execute: async (_i, ctx) => {
        await ctx.requestInput({ title: "T", fields: [] });
        return { data: "x" };
      },
    });
    // No requestInput in the context: asking throws.
    const { reports } = await reportsFor(asking, "{}");
    expect(reports).toEqual([
      expect.objectContaining({
        kind: "tool_threw",
        toolName: ASK_USER,
        message: `${ASK_USER} failed: This run cannot ask the user for input.`,
      }),
    ]);
  });
});

describe("runLoop with files and memory", () => {
  const writer = defineTool({
    name: "writer",
    description: "Writes a session file and a global note.",
    input: z.object({ fail: z.boolean() }),
    approval: "never",
    group: "utilities" as const,
    execute: (input, ctx) => {
      ctx.entries.writeFile("session", "a", "text/plain", "v");
      ctx.entries.addNote("global", "fact");
      return input.fail
        ? { data: "nope", isError: true }
        : { data: { ok: ctx.projectId } };
    },
  });
  const reader = defineTool({
    name: "reader",
    description: "Reads the session file.",
    input: z.object({}),
    approval: "never",
    group: "utilities" as const,
    execute: (_input, ctx) => ({
      data: ctx.entries.readFile("session", "a")?.value ?? null,
    }),
  });

  it("records session changes with the result and passes the project", async () => {
    const shared = new FakeSharedEntries();
    const { saved, ctx, model } = setup(
      [
        [
          call("c1", "writer", '{"fail":false}'),
          { type: "finish", reason: "tool_calls" },
        ],
        [call("c2", "reader", "{}"), { type: "finish", reason: "tool_calls" }],
        [
          { type: "text", text: "Done" },
          { type: "finish", reason: "stop" },
        ],
      ],
      {
        tools: [writer, reader],
        projectId: "p1",
        sharedEntries: shared,
        newNoteId: () => "n1",
      },
    );
    await runLoop(model, request, ctx);
    const [first, second] = results(saved);
    expect(first?.entries).toEqual([
      {
        op: "put",
        kind: "file",
        key: "a",
        value: "v",
        mediaType: "text/plain",
      },
    ]);
    expect(first?.content).toBe('{"ok":"p1"}');
    // The next call sees the change, rebuilt from the transcript.
    expect(second?.content).toBe("v");
    expect(second?.entries).toBeUndefined();
    expect(shared.changes).toEqual([
      {
        kind: "note",
        scope: "global",
        key: "n1",
        op: "put",
        author: { by: "model", sessionId: "s-1", runId: "run-1" },
      },
    ]);
  });

  it("drops session changes when the tool reports an error", async () => {
    const { saved, ctx, model } = setup(
      [
        [
          call("c1", "writer", '{"fail":true}'),
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text", text: "Done" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { tools: [writer], sharedEntries: new FakeSharedEntries() },
    );
    await runLoop(model, request, ctx);
    expect(results(saved)[0]?.entries).toBeUndefined();
  });
});

describe("a tool the agent's setting makes ask", () => {
  const optional = (): Tool =>
    defineTool({
      ...echoSpec,
      approval: "never",
      group: "utilities" as const,
      execute: (input) => ({ data: input.text }),
    });
  const script = [
    [call("c1", "echo", '{"text":"a"}')],
    [{ type: "text" as const, text: "ok" }],
  ];

  it("marks the request when the agent decides", async () => {
    const { events, approvals, ctx, model } = setup(script, {
      tools: [optional()],
      needsApproval: () => true,
      agentDecides: () => true,
    });
    await runLoop(model, request, ctx);
    expect(approvals[0]).toMatchObject({ name: "echo", agentSetting: true });
    expect(
      events.find((e) => e.type === "tool.approval_requested")?.data,
    ).toMatchObject({ agentSetting: true });
  });

  it("does not mark it otherwise", async () => {
    const { events, approvals, ctx, model } = setup(script, {
      tools: [optional()],
      needsApproval: () => true,
      agentDecides: () => false,
    });
    await runLoop(model, request, ctx);
    expect(approvals[0]).not.toHaveProperty("agentSetting");
    expect(
      events.find((e) => e.type === "tool.approval_requested")?.data,
    ).not.toHaveProperty("agentSetting");
  });
});

describe("runLoop as a subagent", () => {
  const handback = defineTool({
    name: "subagent_handback",
    description: "Hands back.",
    input: z.object({ output: z.string() }),
    approval: "never",
    group: "utilities" as const,
    execute: (input) => ({
      data: { handedBack: true },
      handback: input.output,
    }),
  });
  const child = { reminders: 2, reminderText: "Hand back." };
  const done = [{ type: "finish" as const, reason: "stop" as const }];

  it("ends when the handback tool runs and returns its output", async () => {
    const { ctx, model, events } = setup(
      [
        [call("c1", "subagent_handback", '{"output":"all done"}'), ...done],
        [{ type: "text", text: "never reached" }],
      ],
      { tools: [handback, echo], child },
    );
    const result = await runLoop(model, request, ctx);
    expect(result).toMatchObject({ reason: "handed_back", output: "all done" });
    expect(model.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      data: { reason: "handed_back" },
    });
  });

  it("skips calls after the handback in the same response", async () => {
    const { ctx, model, saved } = setup(
      [
        [
          call("c1", "subagent_handback", '{"output":"x"}'),
          call("c2", "echo", '{"text":"hi"}'),
          ...done,
        ],
      ],
      { tools: [handback, echo], child },
    );
    await runLoop(model, request, ctx);
    const second = results(saved).find((m) => m.callId === "c2");
    expect(second?.isError).toBe(true);
  });

  it("sends a reminder as a user message when the child stops without handing back", async () => {
    const { ctx, model, saved } = setup(
      [
        [{ type: "text", text: "thinking" }, ...done],
        [call("c1", "subagent_handback", '{"output":"ok"}'), ...done],
      ],
      { tools: [handback], child },
    );
    const result = await runLoop(model, request, ctx);
    expect(result).toMatchObject({ reason: "handed_back", output: "ok" });
    const reminder = saved.find((s) => s.message.role === "user");
    expect(reminder?.message).toMatchObject({
      content: "Hand back.",
      source: "reminder",
    });
    expect((model.requests[1] as ChatRequest).messages.at(-1)).toMatchObject({
      role: "user",
      content: "Hand back.",
    });
  });

  it("uses the last text as the output when reminders run out", async () => {
    const { ctx, model } = setup(
      [
        [{ type: "text", text: "a" }, ...done],
        [{ type: "text", text: "b" }, ...done],
        [{ type: "text", text: "final" }, ...done],
      ],
      { tools: [handback], child },
    );
    const result = await runLoop(model, request, ctx);
    expect(result).toMatchObject({ reason: "stop", output: "final" });
    expect(model.requests).toHaveLength(3);
  });

  it("does not remind a top-level run", async () => {
    const { ctx, model } = setup([[{ type: "text", text: "hi" }, ...done]]);
    const result = await runLoop(model, request, ctx);
    expect(result.reason).toBe("stop");
    expect(model.requests).toHaveLength(1);
  });

  describe("messages from the user", () => {
    /** A queue the test fills; `take` empties it as the loop does. */
    const queue = (...initial: string[]) => {
      const waiting = [...initial];
      return {
        send: (text: string) => waiting.push(text),
        take: () => waiting.splice(0),
      };
    };
    const lastMessage = (model: { requests: unknown[] }, n: number) =>
      (model.requests[n] as ChatRequest).messages.at(-1);

    it("adds a waiting message as a user message before the next model call", async () => {
      const q = queue();
      const { ctx, model, saved, events } = setup(
        [
          [call("c1", "echo", '{"text":"a"}'), ...done],
          [call("c2", "subagent_handback", '{"output":"ok"}'), ...done],
        ],
        { tools: [handback, echo], child, takeUserMessages: q.take },
      );
      // Sent while the first model call runs.
      q.send("use echo2 instead");
      const result = await runLoop(model, request, ctx);
      expect(result).toMatchObject({ reason: "handed_back", output: "ok" });
      const user = saved.find((s) => s.message.role === "user");
      expect(user?.message).toEqual({
        role: "user",
        content: "use echo2 instead",
        source: "user",
      });
      expect(events.find((e) => e.type === "user.message")?.data).toMatchObject(
        {
          messageId: user?.id,
          source: "user",
          content: "use echo2 instead",
        },
      );
    });

    it("lets the step that is running finish first", async () => {
      const q = queue();
      const send = defineTool({
        name: "send",
        description: "Sends a message while it runs.",
        input: z.object({}),
        approval: "never",
        group: "utilities" as const,
        execute: () => {
          q.send("change of plan");
          return { data: {} };
        },
      });
      const { ctx, model } = setup(
        [
          [
            call("c1", "send", "{}"),
            call("c2", "echo", '{"text":"b"}'),
            ...done,
          ],
          [call("c3", "subagent_handback", '{"output":"ok"}'), ...done],
        ],
        { tools: [handback, echo, send], child, takeUserMessages: q.take },
      );
      await runLoop(model, request, ctx);
      const second = (model.requests[1] as ChatRequest).messages;
      // Both calls of the first response ran; the message came after them.
      expect(second.filter((m) => m.role === "tool")).toHaveLength(2);
      expect(second.at(-1)).toMatchObject({
        role: "user",
        content: "change of plan",
      });
    });

    it("gives a subagent that stopped a step to read it, not a reminder", async () => {
      const q = queue();
      let takes = 0;
      const { ctx, model, saved } = setup(
        [
          [{ type: "text", text: "done?" }, ...done],
          [call("c1", "subagent_handback", '{"output":"ok"}'), ...done],
        ],
        {
          tools: [handback],
          child,
          // Nothing at the start of the step; the message arrives during it.
          takeUserMessages: () => (++takes === 2 ? q.take() : []),
        },
      );
      q.send("not yet");
      const result = await runLoop(model, request, ctx);
      expect(result).toMatchObject({ reason: "handed_back", output: "ok" });
      expect(lastMessage(model, 1)).toMatchObject({ content: "not yet" });
      expect(
        saved.filter((s) => s.message.role === "user").map((s) => s.message),
      ).toHaveLength(1);
    });

    it("gives a subagent that handed back a step to read it", async () => {
      const q = queue();
      let calls = 0;
      const handbackAndSend = defineTool({
        name: "subagent_handback",
        description: "Hands back. The first time, a message arrives meanwhile.",
        input: z.object({ output: z.string() }),
        approval: "never",
        group: "utilities" as const,
        execute: (input) => {
          if (++calls === 1) q.send("wait, also check b");
          return { data: { handedBack: true }, handback: input.output };
        },
      });
      const { ctx, model } = setup(
        [
          [call("c1", "subagent_handback", '{"output":"first"}'), ...done],
          [call("c2", "subagent_handback", '{"output":"second"}'), ...done],
        ],
        { tools: [handbackAndSend], child, takeUserMessages: q.take },
      );
      const result = await runLoop(model, request, ctx);
      expect(result).toMatchObject({ reason: "handed_back", output: "second" });
      expect(model.requests).toHaveLength(2);
      expect(lastMessage(model, 1)).toMatchObject({
        content: "wait, also check b",
      });
    });

    it("does nothing without a queue", async () => {
      const { ctx, model, events } = setup([
        [{ type: "text", text: "hi" }, ...done],
      ]);
      await runLoop(model, request, ctx);
      expect(events.some((e) => e.type === "user.message")).toBe(false);
    });
  });

  it("replays session entries from sessionMessages instead of the transcript", async () => {
    const seen: number[] = [];
    const { ctx, model } = setup(
      [[call("c1", "probe", "{}"), ...done], [{ type: "text", text: "x" }]],
      {
        tools: [
          defineTool({
            name: "probe",
            description: "p",
            input: z.object({}),
            approval: "never",
            group: "utilities" as const,
            execute: () => ({ data: {} }),
          }),
        ],
        sessionMessages: () => {
          seen.push(1);
          return [];
        },
      },
    );
    await runLoop(model, request, ctx);
    expect(seen.length).toBeGreaterThan(0);
  });
});
