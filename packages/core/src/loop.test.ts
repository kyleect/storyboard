import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessEvent, type ApprovalChoice } from "./events.js";
import { ScriptedModel, type ScriptStep } from "./fake-model.js";
import { runLoop, type ApprovalRequest, type LoopContext } from "./loop.js";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "./messages.js";
import type { ChatRequest } from "./model.js";
import { FakeSharedEntries } from "./fake-shared-entries.js";
import { buildMessageContent } from "./message-state.js";
import { defineTool, ToolRunError, type Tool } from "./tools.js";

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
  const saved: { id: string; message: AssistantMessage | ToolResultMessage }[] =
    [];
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
      return Promise.resolve("once");
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
};

describe("approval", () => {
  const asking = (run: () => void = () => {}): Tool =>
    defineTool({
      ...echoSpec,
      approval: "ask",
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
            return Promise.resolve(choice);
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
        approve: () => Promise.resolve("deny"),
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
          return new Promise<ApprovalChoice>(() => {});
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

describe("runLoop with files and memory", () => {
  const writer = defineTool({
    name: "writer",
    description: "Writes a session file and a global note.",
    input: z.object({ fail: z.boolean() }),
    approval: "never",
    execute: (input, ctx) => {
      ctx.entries.writeFile("session", "a", "plain", "v");
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
      { op: "put", kind: "file", key: "a", value: "v", type: "plain" },
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
