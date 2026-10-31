import { z } from "zod";
/** Token usage reported by the model server for one response. */
export declare const Usage: z.ZodObject<{
    promptTokens: z.ZodNumber;
    completionTokens: z.ZodNumber;
}, z.core.$strip>;
export type Usage = z.infer<typeof Usage>;
/** Per-token data from llama-server's native `/completion` (optional). */
export declare const TokenInfo: z.ZodObject<{
    id: z.ZodNumber;
    text: z.ZodString;
    logprob: z.ZodOptional<z.ZodNumber>;
    top: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        text: z.ZodString;
        logprob: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type TokenInfo = z.infer<typeof TokenInfo>;
export declare const TextBlock: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>;
export declare const ReasoningBlock: z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    text: z.ZodString;
}, z.core.$strip>;
export declare const ToolCallBlock: z.ZodObject<{
    type: z.ZodLiteral<"tool_call">;
    callId: z.ZodString;
    name: z.ZodString;
    arguments: z.ZodUnknown;
}, z.core.$strip>;
export declare const ContentBlock: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_call">;
    callId: z.ZodString;
    name: z.ZodString;
    arguments: z.ZodUnknown;
}, z.core.$strip>], "type">;
export type ContentBlock = z.infer<typeof ContentBlock>;
export declare const SystemMessage: z.ZodObject<{
    role: z.ZodLiteral<"system">;
    content: z.ZodString;
}, z.core.$strip>;
export declare const UserMessage: z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodString;
}, z.core.$strip>;
export declare const AssistantMessage: z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_call">;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>], "type">>;
}, z.core.$strip>;
export declare const ToolResultMessage: z.ZodObject<{
    role: z.ZodLiteral<"tool">;
    callId: z.ZodString;
    content: z.ZodString;
    isError: z.ZodBoolean;
}, z.core.$strip>;
/** Provider-neutral message. Model adapters translate to and from it. */
export declare const Message: z.ZodDiscriminatedUnion<[z.ZodObject<{
    role: z.ZodLiteral<"system">;
    content: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_call">;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>], "type">>;
}, z.core.$strip>, z.ZodObject<{
    role: z.ZodLiteral<"tool">;
    callId: z.ZodString;
    content: z.ZodString;
    isError: z.ZodBoolean;
}, z.core.$strip>], "role">;
export type Message = z.infer<typeof Message>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;
/** A tool the model may call. `inputSchema` is JSON Schema. */
export declare const ToolDefinition: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    inputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
export type ToolDefinition = z.infer<typeof ToolDefinition>;
