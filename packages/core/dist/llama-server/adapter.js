import { readSseData } from "./sse.js";
export class LlamaServerError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "LlamaServerError";
    }
}
export class LlamaServerAdapter {
    baseUrl;
    fetch;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.fetch = options.fetch ?? globalThis.fetch;
    }
    async *stream(request, signal) {
        try {
            if (request.kind === "chat")
                yield* this.chat(request, signal);
            else
                yield* this.raw(request, signal);
        }
        catch (err) {
            // Cancellation is not an error; the caller sees the signal.
            if (signal.aborted)
                return;
            throw err;
        }
    }
    async *chat(request, signal) {
        const body = {
            messages: request.messages.map(toOpenAiMessage),
            stream: true,
            stream_options: { include_usage: true },
            ...sampling(request.sampling, "max_tokens"),
        };
        if (request.model !== undefined)
            body.model = request.model;
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
        const calls = new Map();
        let finish;
        for await (const data of readSseData(res)) {
            if (data === "[DONE]")
                break;
            const chunk = parseJson(data);
            if (chunk.error !== undefined)
                throw serverError(chunk.error);
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
            if (!choice)
                continue;
            const delta = choice.delta ?? {};
            if (typeof delta.reasoning_content === "string" &&
                delta.reasoning_content) {
                yield { type: "reasoning", text: delta.reasoning_content };
            }
            if (typeof delta.content === "string" && delta.content) {
                yield { type: "text", text: delta.content };
            }
            for (const tc of delta.tool_calls ?? []) {
                const call = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
                if (tc.id)
                    call.id = tc.id;
                if (tc.function?.name)
                    call.name += tc.function.name;
                if (tc.function?.arguments)
                    call.arguments += tc.function.arguments;
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
        if (finish)
            yield finish;
    }
    async *raw(request, signal) {
        const body = {
            prompt: request.prompt,
            stream: true,
            ...sampling(request.sampling, "n_predict"),
        };
        if (request.model !== undefined)
            body.model = request.model;
        if (request.tokenInfo)
            body.n_probs = request.tokenInfo.topN;
        const res = await this.post("/completion", body, signal);
        // The native endpoint sends no [DONE]; the last chunk has `stop: true`.
        for await (const data of readSseData(res)) {
            const chunk = parseJson(data);
            if (chunk.error !== undefined)
                throw serverError(chunk.error);
            if (typeof chunk.content === "string" && chunk.content) {
                const tokens = toTokenInfo(chunk.completion_probabilities);
                yield tokens
                    ? { type: "text", text: chunk.content, tokens }
                    : { type: "text", text: chunk.content };
            }
            if (chunk.stop === true) {
                if (typeof chunk.tokens_evaluated === "number" &&
                    typeof chunk.tokens_predicted === "number") {
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
    async post(path, body, signal) {
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
                const parsed = JSON.parse(text);
                if (parsed.error?.message)
                    message = parsed.error.message;
            }
            catch {
                // not JSON; keep the text
            }
            throw new LlamaServerError(`llama-server ${path} returned ${res.status}: ${message}`, res.status);
        }
        if (!res.body)
            throw new LlamaServerError(`llama-server ${path}: no body`);
        return res.body;
    }
}
function sampling(s, maxTokensField) {
    const out = {};
    if (!s)
        return out;
    if (s.temperature !== undefined)
        out.temperature = s.temperature;
    if (s.topP !== undefined)
        out.top_p = s.topP;
    if (s.topK !== undefined)
        out.top_k = s.topK;
    if (s.minP !== undefined)
        out.min_p = s.minP;
    if (s.repeatPenalty !== undefined)
        out.repeat_penalty = s.repeatPenalty;
    if (s.seed !== undefined)
        out.seed = s.seed;
    if (s.maxTokens !== undefined)
        out[maxTokensField] = s.maxTokens;
    return out;
}
/** Converts a harness message to the OpenAI-style shape llama-server reads. */
export function toOpenAiMessage(m) {
    switch (m.role) {
        case "system":
        case "user":
            return { role: m.role, content: m.content };
        case "tool":
            return { role: "tool", tool_call_id: m.callId, content: m.content };
        case "assistant": {
            let content = "";
            let reasoning = "";
            const toolCalls = [];
            for (const block of m.content) {
                if (block.type === "text")
                    content += block.text;
                else if (block.type === "reasoning")
                    reasoning += block.text;
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
            const out = { role: "assistant", content };
            if (reasoning)
                out.reasoning_content = reasoning;
            if (toolCalls.length > 0)
                out.tool_calls = toolCalls;
            return out;
        }
    }
}
function toFinishReason(r) {
    if (r === "length")
        return "length";
    if (r === "tool_calls")
        return "tool_calls";
    return "stop";
}
function toTokenInfo(probs) {
    if (!Array.isArray(probs) || probs.length === 0)
        return undefined;
    return probs.map((p) => {
        const info = { id: p.id, text: p.token };
        if (p.logprob !== undefined)
            info.logprob = p.logprob;
        if (p.top_logprobs)
            info.top = p.top_logprobs.map((t) => ({
                id: t.id,
                text: t.token,
                logprob: t.logprob,
            }));
        return info;
    });
}
function parseJson(data) {
    try {
        return JSON.parse(data);
    }
    catch {
        throw new LlamaServerError(`llama-server sent invalid JSON: ${data.slice(0, 200)}`);
    }
}
function serverError(error) {
    const e = error;
    return new LlamaServerError(`llama-server error: ${e?.message ?? JSON.stringify(error)}`, e?.code);
}
//# sourceMappingURL=adapter.js.map