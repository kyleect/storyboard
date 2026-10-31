import type { Message, TokenInfo } from "../messages.js";
import type {
  ChatRequest,
  ModelAdapter,
  ModelChunk,
  ModelRequest,
  RawRequest,
  Sampling,
} from "../model.js";
import { readSseData } from "./sse.js";

/*
 * Model adapter for llama.cpp's llama-server.
 *
 * - Chat: POST /v1/chat/completions, streamed. The server applies the chat
 *   template. A trailing assistant message is continued (assistant prefill).
 * - Raw: POST /completion (native), streamed. Plain text, no template.
 *
 * Wire formats follow llama.cpp master (tools/server/server-task.cpp,
 * server-chat.cpp, server-context.cpp). In router mode the `model` field
 * selects the model.
 */

export interface LlamaServerOptions {
  /** For example `http://127.0.0.1:8080`. */
  baseUrl: string;
  fetch?: typeof fetch;
}

export class LlamaServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlamaServerError";
  }
}

export class LlamaServerAdapter implements ModelAdapter {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: LlamaServerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    try {
      if (request.kind === "chat") yield* this.chat(request, signal);
      else yield* this.raw(request, signal);
    } catch (err) {
      // Cancellation is not an error; the caller sees the signal.
      if (signal.aborted) return;
      throw err;
    }
  }

  private async *chat(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelChunk> {
    const body: Record<string, unknown> = {
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...sampling(request.sampling, "max_tokens"),
    };
    if (request.model !== undefined) body.model = request.model;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const res = await this.post("/v1/chat/completions", body, signal);

    // Tool calls arrive in pieces, keyed by index; emitted once complete.
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finish: ModelChunk | undefined;

    for await (const data of readSseData(res)) {
      if (data === "[DONE]") break;
      const chunk = parseJson(data);
      if (chunk.error !== undefined) throw serverError(chunk.error);

      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          },
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content
      ) {
        yield { type: "reasoning", text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const call = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(tc.index, call);
      }

      if (choice.finish_reason) {
        finish = {
          type: "finish",
          reason: toFinishReason(choice.finish_reason),
        };
      }
    }

    for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
      yield {
        type: "tool_call",
        callId: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments,
      };
    }
    if (finish) yield finish;
  }

  private async *raw(
    request: RawRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelChunk> {
    const body: Record<string, unknown> = {
      prompt: request.prompt,
      stream: true,
      ...sampling(request.sampling, "n_predict"),
    };
    if (request.model !== undefined) body.model = request.model;
    if (request.tokenInfo) body.n_probs = request.tokenInfo.topN;

    const res = await this.post("/completion", body, signal);

    // The native endpoint sends no [DONE]; the last chunk has `stop: true`.
    for await (const data of readSseData(res)) {
      const chunk = parseJson(data);
      if (chunk.error !== undefined) throw serverError(chunk.error);

      if (typeof chunk.content === "string" && chunk.content) {
        const tokens = toTokenInfo(chunk.completion_probabilities);
        yield tokens
          ? { type: "text", text: chunk.content, tokens }
          : { type: "text", text: chunk.content };
      }

      if (chunk.stop === true) {
        if (
          typeof chunk.tokens_evaluated === "number" &&
          typeof chunk.tokens_predicted === "number"
        ) {
          yield {
            type: "usage",
            usage: {
              promptTokens: chunk.tokens_evaluated,
              completionTokens: chunk.tokens_predicted,
            },
          };
        }
        yield {
          type: "finish",
          reason: chunk.stop_type === "limit" ? "length" : "stop",
        };
        break;
      }
    }
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text || res.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // not JSON; keep the text
      }
      throw new LlamaServerError(
        `llama-server ${path} returned ${res.status}: ${message}`,
        res.status,
      );
    }
    if (!res.body) throw new LlamaServerError(`llama-server ${path}: no body`);
    return res.body;
  }
}

function sampling(
  s: Sampling | undefined,
  maxTokensField: "max_tokens" | "n_predict",
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  if (s.temperature !== undefined) out.temperature = s.temperature;
  if (s.topP !== undefined) out.top_p = s.topP;
  if (s.topK !== undefined) out.top_k = s.topK;
  if (s.minP !== undefined) out.min_p = s.minP;
  if (s.repeatPenalty !== undefined) out.repeat_penalty = s.repeatPenalty;
  if (s.seed !== undefined) out.seed = s.seed;
  if (s.maxTokens !== undefined) out[maxTokensField] = s.maxTokens;
  return out;
}

/** Converts a harness message to the OpenAI-style shape llama-server reads. */
export function toOpenAiMessage(m: Message): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.callId, content: m.content };
    case "assistant": {
      let content = "";
      let reasoning = "";
      const toolCalls: unknown[] = [];
      for (const block of m.content) {
        if (block.type === "text") content += block.text;
        else if (block.type === "reasoning") reasoning += block.text;
        else
          toolCalls.push({
            id: block.callId,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}),
            },
          });
      }
      const out: Record<string, unknown> = { role: "assistant", content };
      if (reasoning) out.reasoning_content = reasoning;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      return out;
    }
  }
}

function toFinishReason(r: string): "stop" | "length" | "tool_calls" {
  if (r === "length") return "length";
  if (r === "tool_calls") return "tool_calls";
  return "stop";
}

interface ProbEntry {
  id: number;
  token: string;
  logprob?: number;
  top_logprobs?: { id: number; token: string; logprob: number }[];
}

function toTokenInfo(probs: unknown): TokenInfo[] | undefined {
  if (!Array.isArray(probs) || probs.length === 0) return undefined;
  return (probs as ProbEntry[]).map((p) => {
    const info: TokenInfo = { id: p.id, text: p.token };
    if (p.logprob !== undefined) info.logprob = p.logprob;
    if (p.top_logprobs)
      info.top = p.top_logprobs.map((t) => ({
        id: t.id,
        text: t.token,
        logprob: t.logprob,
      }));
    return info;
  });
}

/* Loose shapes of what llama-server streams; validated by use. */
interface StreamChunk {
  error?: unknown;
  usage?: { prompt_tokens: number; completion_tokens: number };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  // native /completion
  content?: string;
  stop?: boolean;
  stop_type?: string;
  tokens_evaluated?: number;
  tokens_predicted?: number;
  completion_probabilities?: unknown;
}

function parseJson(data: string): StreamChunk {
  try {
    return JSON.parse(data) as StreamChunk;
  } catch {
    throw new LlamaServerError(
      `llama-server sent invalid JSON: ${data.slice(0, 200)}`,
    );
  }
}

function serverError(error: unknown): LlamaServerError {
  const e = error as { message?: string; code?: number };
  return new LlamaServerError(
    `llama-server error: ${e?.message ?? JSON.stringify(error)}`,
    e?.code,
  );
}
