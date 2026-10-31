export type Frame = string
/** Wait before the next frame. */
 | {
    delayMs: number;
}
/** Stop sending and keep the connection open until the client leaves. */
 | {
    hang: true;
};
export interface Reply {
    status?: number;
    /** Used when status is not 200. */
    errorBody?: unknown;
    frames?: Frame[];
}
export interface RecordedRequest {
    method: string;
    path: string;
    body: unknown;
}
export declare class FakeLlamaServer {
    readonly requests: RecordedRequest[];
    /** Set when a client disconnects during a `hang`. */
    clientClosed: boolean;
    private readonly replies;
    private readonly gets;
    private server;
    /**
     * Answer every GET of `path` (query string ignored) with JSON. GETs without
     * an answer get 404.
     */
    onGet(path: string, body: unknown, status?: number): this;
    /** Queue replies for POSTs; each POST takes the next one. */
    reply(...replies: Reply[]): this;
    start(): Promise<string>;
    stop(): Promise<void>;
    private send;
}
/** One SSE event as `format_oai_sse` writes it. */
export declare const sse: (data: unknown) => string;
export declare const DONE = "data: [DONE]\n\n";
/** llama-server's keepalive ping. */
export declare const PING = ":\n\n";
/** A `chat.completion.chunk` with one choice. */
export declare function chatChunk(delta: Record<string, unknown>, finishReason?: string | null): string;
/** The usage chunk sent last when `stream_options.include_usage` is set. */
export declare function chatUsage(prompt: number, completion: number): string;
/** A partial chunk from native `/completion`. */
export declare function completionPartial(content: string, extra?: Record<string, unknown>): string;
/** The final chunk from native `/completion` when streaming (content empty). */
export declare function completionFinal(opts: {
    stopType: "eos" | "limit" | "word";
    promptTokens: number;
    predicted: number;
}): string;
