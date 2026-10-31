import { createServer } from "node:http";
export class FakeLlamaServer {
    requests = [];
    /** Set when a client disconnects during a `hang`. */
    clientClosed = false;
    replies = [];
    server;
    /** Queue replies; each request takes the next one. */
    reply(...replies) {
        this.replies.push(...replies);
        return this;
    }
    async start() {
        const server = createServer((req, res) => {
            let raw = "";
            req.setEncoding("utf8");
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                this.requests.push({
                    path: req.url ?? "",
                    body: JSON.parse(raw || "null"),
                });
                const reply = this.replies.shift();
                if (!reply) {
                    res.writeHead(500).end("FakeLlamaServer: no reply queued");
                    return;
                }
                void this.send(res, reply);
            });
        });
        this.server = server;
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        return `http://127.0.0.1:${port}`;
    }
    async stop() {
        this.server?.closeAllConnections();
        await new Promise((resolve) => this.server?.close(() => resolve()));
    }
    async send(res, reply) {
        const status = reply.status ?? 200;
        if (status !== 200) {
            res
                .writeHead(status, { "content-type": "application/json" })
                .end(JSON.stringify(reply.errorBody ?? {}));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const frame of reply.frames ?? []) {
            if (typeof frame === "string")
                res.write(frame);
            else if ("delayMs" in frame)
                await sleep(frame.delayMs);
            else {
                await new Promise((resolve) => res.on("close", () => {
                    this.clientClosed = true;
                    resolve();
                }));
                return;
            }
        }
        res.end();
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One SSE event as `format_oai_sse` writes it. */
export const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
export const DONE = "data: [DONE]\n\n";
/** llama-server's keepalive ping. */
export const PING = ":\n\n";
/** A `chat.completion.chunk` with one choice. */
export function chatChunk(delta, finishReason = null) {
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
export function chatUsage(prompt, completion) {
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
export function completionPartial(content, extra = {}) {
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
export function completionFinal(opts) {
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
//# sourceMappingURL=fake-llama-server.js.map