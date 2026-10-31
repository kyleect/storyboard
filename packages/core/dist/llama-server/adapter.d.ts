import type { Message } from "../messages.js";
import type { ModelAdapter, ModelChunk, ModelRequest } from "../model.js";
export interface LlamaServerOptions {
    /** For example `http://127.0.0.1:8080`. */
    baseUrl: string;
    fetch?: typeof fetch;
}
export declare class LlamaServerError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare class LlamaServerAdapter implements ModelAdapter {
    private readonly baseUrl;
    private readonly fetch;
    constructor(options: LlamaServerOptions);
    stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
    private chat;
    private raw;
    private post;
}
/** Converts a harness message to the OpenAI-style shape llama-server reads. */
export declare function toOpenAiMessage(m: Message): Record<string, unknown>;
