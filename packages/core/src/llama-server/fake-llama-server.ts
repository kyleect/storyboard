import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A fake llama-server for tests. It replays scripted bytes over real HTTP, so
 * the adapter's network and SSE parsing are exercised. The frame helpers
 * build payloads in the shapes llama.cpp master sends
 * (tools/server/server-task.cpp, server-chat.cpp, server-context.cpp).
 */

export type Frame =
  | string
  /** Wait before the next frame. */
  | { delayMs: number }
  /** Stop sending and keep the connection open until the client leaves. */
  | { hang: true };

export interface Reply {
  status?: number;
  /** Used when status is not 200. */
  errorBody?: unknown;
  /** A plain JSON answer instead of an event stream. */
  json?: unknown;
  frames?: Frame[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export class FakeLlamaServer {
  readonly requests: RecordedRequest[] = [];
  /** Set when a client disconnects during a `hang`. */
  clientClosed = false;
  private readonly replies: Reply[] = [];
  private readonly gets = new Map<
    string,
    { status: number; body: unknown; delayMs: number }
  >();
  private server: Server | undefined;
  private embedder:
    | ((inputs: string[], model: string | undefined) => number[][] | Error)
    | undefined;

  /**
   * Answer POST /v1/embeddings with these vectors (OpenAI shape), or with
   * a 400 error when the function returns an Error. Without it, embeddings
   * requests take the next queued reply like any POST.
   */
  onEmbeddings(
    fn: (inputs: string[], model: string | undefined) => number[][] | Error,
  ): this {
    this.embedder = fn;
    return this;
  }

  /**
   * Answer every GET of `path` (query string ignored) with JSON. GETs without
   * an answer get 404.
   */
  onGet(path: string, body: unknown, status = 200, delayMs = 0): this {
    this.gets.set(path, { status, body, delayMs });
    return this;
  }

  /** Queue replies for POSTs; each POST takes the next one. */
  reply(...replies: Reply[]): this {
    this.replies.push(...replies);
    return this;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (raw += c));
      req.on("end", () => {
        this.requests.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body: JSON.parse(raw || "null"),
        });
        if (req.method === "GET") {
          const answer = this.gets.get((req.url ?? "").split("?")[0] ?? "");
          void sleep(answer?.delayMs ?? 0).then(() =>
            res
              .writeHead(answer?.status ?? 404, {
                "content-type": "application/json",
              })
              .end(
                JSON.stringify(
                  answer?.body ?? {
                    error: { code: 404, message: "Not Found" },
                  },
                ),
              ),
          );
          return;
        }
        if (this.embedder && (req.url ?? "").startsWith("/v1/embeddings")) {
          const body = JSON.parse(raw || "{}") as {
            input?: string | string[];
            model?: string;
          };
          const inputs =
            typeof body.input === "string" ? [body.input] : (body.input ?? []);
          const result = this.embedder(inputs, body.model);
          res.writeHead(result instanceof Error ? 400 : 200, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify(
              result instanceof Error
                ? { error: { code: 400, message: result.message } }
                : {
                    object: "list",
                    model: body.model ?? "test-model",
                    data: result.map((embedding, index) => ({
                      object: "embedding",
                      index,
                      embedding,
                    })),
                  },
            ),
          );
          return;
        }
        const reply = this.replies.shift();
        if (!reply) {
          res.writeHead(500).end("FakeLlamaServer: no reply queued");
          return;
        }
        void this.send(res, reply);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async send(res: import("node:http").ServerResponse, reply: Reply) {
    const status = reply.status ?? 200;
    if (status !== 200) {
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(reply.errorBody ?? {}));
      return;
    }
    if (reply.json !== undefined) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(reply.json));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of reply.frames ?? []) {
      if (typeof frame === "string") res.write(frame);
      else if ("delayMs" in frame) await sleep(frame.delayMs);
      else {
        await new Promise<void>((resolve) =>
          res.on("close", () => {
            this.clientClosed = true;
            resolve();
          }),
        );
        return;
      }
    }
    res.end();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One SSE event as `format_oai_sse` writes it. */
export const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
export const DONE = "data: [DONE]\n\n";
/** llama-server's keepalive ping. */
export const PING = ":\n\n";

/** A `chat.completion.chunk` with one choice. */
export function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return sse({
    choices: [{ finish_reason: finishReason, index: 0, delta }],
    created: 0,
    id: "chatcmpl-test",
    model: "test-model",
    system_fingerprint: "test",
    object: "chat.completion.chunk",
  });
}

/** The usage chunk sent last when `stream_options.include_usage` is set. */
export function chatUsage(prompt: number, completion: number) {
  return sse({
    choices: [],
    created: 0,
    id: "chatcmpl-test",
    model: "test-model",
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: completion,
      prompt_tokens: prompt,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    timings: {},
  });
}

/** A partial chunk from native `/completion`. */
export function completionPartial(
  content: string,
  extra: Record<string, unknown> = {},
) {
  return sse({
    index: 0,
    content,
    tokens: [],
    stop: false,
    id_slot: 0,
    tokens_predicted: 0,
    tokens_evaluated: 0,
    ...extra,
  });
}

/** The final chunk from native `/completion` when streaming (content empty). */
export function completionFinal(opts: {
  stopType: "eos" | "limit" | "word";
  promptTokens: number;
  predicted: number;
}) {
  return sse({
    index: 0,
    content: "",
    tokens: [],
    id_slot: 0,
    stop: true,
    model: "test-model",
    tokens_predicted: opts.predicted,
    tokens_evaluated: opts.promptTokens,
    stop_type: opts.stopType,
    stopping_word: "",
    timings: {},
  });
}
