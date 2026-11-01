import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../events.js";
import type { ModelChunk, ModelRequest } from "../model.js";
import { RunControl } from "../control.js";
import { runSingleCall } from "../run.js";
import { LlamaServerAdapter, LlamaServerError } from "./adapter.js";
import {
  chatChunk,
  chatUsage,
  completionFinal,
  completionPartial,
  DONE,
  FakeLlamaServer,
  PING,
  sse,
} from "./fake-llama-server.js";

let server: FakeLlamaServer;
let adapter: LlamaServerAdapter;

beforeEach(async () => {
  server = new FakeLlamaServer();
  adapter = new LlamaServerAdapter({ baseUrl: (await server.start()) + "/" });
});
afterEach(() => server.stop());

async function collect(
  request: ModelRequest,
  signal = new AbortController().signal,
) {
  const chunks: ModelChunk[] = [];
  for await (const c of adapter.stream(request, signal)) chunks.push(c);
  return chunks;
}

describe("chat completions", () => {
  it("sends the request in llama-server's shape", async () => {
    server.reply({ frames: [chatChunk({}, "stop"), DONE] });

    await collect({
      kind: "chat",
      model: "qwen",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "hmm" },
            { type: "text", text: "Hello" },
            { type: "tool_call", callId: "c1", name: "now", arguments: {} },
          ],
        },
        {
          role: "tool",
          callId: "c1",
          name: "now",
          content: "noon",
          isError: false,
        },
      ],
      tools: [
        {
          name: "now",
          description: "Current time",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      sampling: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.1,
        seed: 1,
        maxTokens: 64,
      },
    });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/v1/chat/completions");
    expect(server.requests[0]?.body).toEqual({
      model: "qwen",
      stream: true,
      stream_options: { include_usage: true },
      timings_per_token: true,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      seed: 1,
      max_tokens: 64,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Hello",
          reasoning_content: "hmm",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "now", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "noon" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "now",
            description: "Current time",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
  });

  it("omits model when not given", async () => {
    server.reply({ frames: [DONE] });
    await collect({ kind: "chat", messages: [{ role: "user", content: "x" }] });
    expect(server.requests[0]?.body).not.toHaveProperty("model");
  });

  it("joins an edit message to the next user message", async () => {
    server.reply({ frames: [DONE] });
    await collect({
      kind: "chat",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        {
          role: "edit",
          content: "[The user changed session file x in the app.]",
          entries: [{ op: "put", kind: "file", key: "x", value: "v" }],
        },
        { role: "user", content: "c" },
      ],
    });
    expect(
      (server.requests[0]?.body as { messages: unknown[] }).messages,
    ).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      {
        role: "user",
        content: "[The user changed session file x in the app.]\n\nc",
      },
    ]);
  });

  it("yields reasoning, text, usage and finish", async () => {
    server.reply({
      frames: [
        chatChunk({ role: "assistant", content: null }),
        chatChunk({ reasoning_content: "Think" }),
        PING,
        chatChunk({ content: "Hel" }),
        chatChunk({ content: "lo" }),
        chatChunk({}, "stop"),
        chatUsage(12, 3),
        DONE,
      ],
    });

    expect(await collect({ kind: "chat", messages: [] })).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "usage", usage: { promptTokens: 12, completionTokens: 3 } },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("assembles tool calls sent in pieces", async () => {
    server.reply({
      frames: [
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "search" },
            },
          ],
        }),
        chatChunk({
          tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
        }),
        chatChunk({
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "now" },
            },
          ],
        }),
        chatChunk({
          tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }],
        }),
        chatChunk({}, "tool_calls"),
        DONE,
      ],
    });

    expect(await collect({ kind: "chat", messages: [] })).toEqual([
      {
        type: "tool_call",
        callId: "call_a",
        name: "search",
        arguments: '{"q":"cats"}',
      },
      { type: "tool_call", callId: "call_b", name: "now", arguments: "" },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("parses events split across network writes and CRLF line endings", async () => {
    const event = chatChunk({ content: "split" });
    const crlf = chatChunk({ content: "!" }).replace(/\n/g, "\r\n");
    server.reply({
      frames: [
        event.slice(0, 7),
        { delayMs: 5 },
        event.slice(7, 30),
        { delayMs: 5 },
        event.slice(30),
        crlf,
        DONE,
      ],
    });

    expect(await collect({ kind: "chat", messages: [] })).toEqual([
      { type: "text", text: "split" },
      { type: "text", text: "!" },
    ]);
  });

  it("throws the message from an HTTP error", async () => {
    server.reply({
      status: 400,
      errorBody: {
        error: {
          code: 400,
          message:
            "Cannot have 2 or more assistant messages at the end of the list.",
          type: "invalid_request_error",
        },
      },
    });

    const err = await collect({ kind: "chat", messages: [] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlamaServerError);
    expect((err as LlamaServerError).status).toBe(400);
    expect((err as Error).message).toContain(
      "Cannot have 2 or more assistant messages",
    );
  });

  it("throws on an error sent mid-stream", async () => {
    server.reply({
      frames: [
        chatChunk({ content: "partial" }),
        sse({
          error: {
            code: 500,
            message: "context overflow",
            type: "server_error",
          },
        }),
      ],
    });

    const chunks: ModelChunk[] = [];
    const err = await (async () => {
      for await (const c of adapter.stream(
        { kind: "chat", messages: [] },
        new AbortController().signal,
      ))
        chunks.push(c);
    })().catch((e: unknown) => e);

    expect(chunks).toEqual([{ type: "text", text: "partial" }]);
    expect((err as Error).message).toContain("context overflow");
  });

  it("stops quietly and closes the connection when aborted", async () => {
    server.reply({ frames: [chatChunk({ content: "Once" }), { hang: true }] });
    const controller = new AbortController();
    const chunks: ModelChunk[] = [];

    for await (const c of adapter.stream(
      { kind: "chat", messages: [] },
      controller.signal,
    )) {
      chunks.push(c);
      controller.abort();
    }

    expect(chunks).toEqual([{ type: "text", text: "Once" }]);
    await expect.poll(() => server.clientClosed).toBe(true);
  });
});

describe("reasoning", () => {
  it("sends the reasoning effort", async () => {
    server.reply({ frames: [DONE] });
    await collect({ kind: "chat", messages: [], reasoningEffort: "none" });
    expect(server.requests[0]?.body).toMatchObject({
      reasoning_effort: "none",
    });
    expect(server.requests[0]?.body).not.toHaveProperty("reasoning_control");
  });

  it("ends reasoning through the control endpoint while streaming", async () => {
    server.reply(
      {
        frames: [
          chatChunk({ role: "assistant", content: null }),
          chatChunk({ reasoning_content: "Thinking" }),
          { hang: true },
        ],
      },
      { json: { success: true } },
    );
    const control = new RunControl();
    const controller = new AbortController();
    const before = await control.endReasoning();

    for await (const c of adapter.stream(
      { kind: "chat", model: "qwen", messages: [], control },
      controller.signal,
    )) {
      if (c.type === "reasoning") {
        expect(await control.endReasoning()).toEqual({ ok: true });
        controller.abort();
      }
    }

    expect(before.ok).toBe(false);
    expect(server.requests[0]?.body).toMatchObject({ reasoning_control: true });
    expect(server.requests[1]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions/control",
      body: { id: "chatcmpl-test", action: "reasoning_end", model: "qwen" },
    });
    // Unbound once the response is over.
    expect((await control.endReasoning()).ok).toBe(false);
  });

  it("reports the server refusing to end reasoning", async () => {
    server.reply(
      {
        frames: [chatChunk({ reasoning_content: "x" }), { hang: true }],
      },
      {
        json: {
          success: false,
          message: "reasoning control not enabled for this completion",
        },
      },
    );
    const control = new RunControl();
    const controller = new AbortController();
    let result;
    for await (const c of adapter.stream(
      { kind: "chat", messages: [], control },
      controller.signal,
    )) {
      if (c.type === "reasoning") {
        result = await control.endReasoning();
        controller.abort();
      }
    }
    expect(result).toEqual({
      ok: false,
      message: "reasoning control not enabled for this completion",
    });
    expect(server.requests[1]?.body).not.toHaveProperty("model");
  });

  it("turns per-chunk timings into a running token count", async () => {
    const withTimings = (delta: Record<string, unknown>, n: number) =>
      sse({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, finish_reason: null, delta }],
        timings: { cache_n: 2, prompt_n: 3, predicted_n: n },
      });
    server.reply({
      frames: [
        withTimings({ reasoning_content: "a" }, 1),
        withTimings({ reasoning_content: "b" }, 2),
        chatChunk({}, "stop"),
        chatUsage(5, 2),
        DONE,
      ],
    });
    expect(await collect({ kind: "chat", messages: [] })).toEqual([
      { type: "usage", usage: { promptTokens: 5, completionTokens: 1 } },
      { type: "reasoning", text: "a" },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 2 } },
      { type: "reasoning", text: "b" },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 2 } },
      { type: "finish", reason: "stop" },
    ]);
  });
});

describe("native /completion", () => {
  it("sends a raw prompt and yields text, usage and finish", async () => {
    server.reply({
      frames: [
        completionPartial("Once"),
        completionPartial(" upon"),
        completionFinal({ stopType: "limit", promptTokens: 4, predicted: 2 }),
      ],
    });

    const chunks = await collect({
      kind: "raw",
      model: "qwen",
      prompt: "Story:",
      sampling: { temperature: 0.8, maxTokens: 2 },
    });

    expect(server.requests[0]?.path).toBe("/completion");
    expect(server.requests[0]?.body).toEqual({
      model: "qwen",
      prompt: "Story:",
      stream: true,
      temperature: 0.8,
      n_predict: 2,
    });
    expect(chunks).toEqual([
      { type: "text", text: "Once" },
      { type: "text", text: " upon" },
      { type: "usage", usage: { promptTokens: 4, completionTokens: 2 } },
      { type: "finish", reason: "length" },
    ]);
  });

  it("maps end of sequence and stop words to stop", async () => {
    server.reply(
      {
        frames: [
          completionFinal({ stopType: "eos", promptTokens: 1, predicted: 0 }),
        ],
      },
      {
        frames: [
          completionFinal({ stopType: "word", promptTokens: 1, predicted: 0 }),
        ],
      },
    );
    expect((await collect({ kind: "raw", prompt: "" })).at(-1)).toEqual({
      type: "finish",
      reason: "stop",
    });
    expect((await collect({ kind: "raw", prompt: "" })).at(-1)).toEqual({
      type: "finish",
      reason: "stop",
    });
  });

  it("requests and passes through token probabilities", async () => {
    server.reply({
      frames: [
        completionPartial("Once", {
          tokens: [12522],
          completion_probabilities: [
            {
              id: 12522,
              token: "Once",
              bytes: [79, 110, 99, 101],
              logprob: -0.25,
              top_logprobs: [
                {
                  id: 12522,
                  token: "Once",
                  bytes: [79, 110, 99, 101],
                  logprob: -0.25,
                },
                {
                  id: 791,
                  token: "The",
                  bytes: [84, 104, 101],
                  logprob: -1.75,
                },
              ],
            },
          ],
        }),
        completionFinal({ stopType: "eos", promptTokens: 1, predicted: 1 }),
      ],
    });

    const chunks = await collect({
      kind: "raw",
      prompt: "",
      tokenInfo: { topN: 2 },
    });

    expect(server.requests[0]?.body).toMatchObject({ n_probs: 2 });
    expect(chunks[0]).toEqual({
      type: "text",
      text: "Once",
      tokens: [
        {
          id: 12522,
          text: "Once",
          logprob: -0.25,
          top: [
            { id: 12522, text: "Once", logprob: -0.25 },
            { id: 791, text: "The", logprob: -1.75 },
          ],
        },
      ],
    });
  });
});

describe("with runSingleCall", () => {
  it("produces the event stream from a llama-server response", async () => {
    server.reply({
      frames: [
        chatChunk({ role: "assistant", content: null }),
        chatChunk({ reasoning_content: "ok" }),
        chatChunk({ content: "Hi there" }),
        chatChunk({}, "stop"),
        chatUsage(5, 2),
        DONE,
      ],
    });
    const events: HarnessEvent[] = [];

    const result = await runSingleCall(
      adapter,
      { kind: "chat", messages: [{ role: "user", content: "Hi" }] },
      {
        runId: "r",
        sessionId: "s",
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
      },
    );

    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "message.started",
      "reasoning.delta",
      "reasoning.end",
      "text.delta",
      "text.end",
      "message.finished",
      "run.finished",
    ]);
    expect(result.message.content).toEqual([
      { type: "reasoning", text: "ok" },
      { type: "text", text: "Hi there" },
    ]);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });
});
