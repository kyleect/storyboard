import { z } from "zod";
/** Token usage reported by the model server for one response. */
export const Usage = z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
});
/** Per-token data from llama-server's native `/completion` (optional). */
export const TokenInfo = z.object({
    id: z.number().int(),
    text: z.string(),
    logprob: z.number().optional(),
    top: z
        .array(z.object({
        id: z.number().int(),
        text: z.string(),
        logprob: z.number(),
    }))
        .optional(),
});
export const TextBlock = z.object({
    type: z.literal("text"),
    text: z.string(),
});
export const ReasoningBlock = z.object({
    type: z.literal("reasoning"),
    text: z.string(),
});
export const ToolCallBlock = z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    /** Parsed arguments. */
    arguments: z.unknown(),
});
export const ContentBlock = z.discriminatedUnion("type", [
    TextBlock,
    ReasoningBlock,
    ToolCallBlock,
]);
export const SystemMessage = z.object({
    role: z.literal("system"),
    content: z.string(),
});
export const UserMessage = z.object({
    role: z.literal("user"),
    content: z.string(),
});
export const AssistantMessage = z.object({
    role: z.literal("assistant"),
    content: z.array(ContentBlock),
});
export const ToolResultMessage = z.object({
    role: z.literal("tool"),
    callId: z.string(),
    content: z.string(),
    isError: z.boolean(),
});
/** Provider-neutral message. Model adapters translate to and from it. */
export const Message = z.discriminatedUnion("role", [
    SystemMessage,
    UserMessage,
    AssistantMessage,
    ToolResultMessage,
]);
/** A tool the model may call. `inputSchema` is JSON Schema. */
export const ToolDefinition = z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
});
//# sourceMappingURL=messages.js.map