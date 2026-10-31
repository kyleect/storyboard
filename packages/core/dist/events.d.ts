import { z } from "zod";
export declare const RunKind: z.ZodEnum<{
    single: "single";
    loop: "loop";
    pipeline: "pipeline";
}>;
export declare const RunStarted: z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    data: z.ZodObject<{
        kind: z.ZodEnum<{
            single: "single";
            loop: "loop";
            pipeline: "pipeline";
        }>;
        parentRunId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const StepStarted: z.ZodObject<{
    type: z.ZodLiteral<"step.started">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const StepFinished: z.ZodObject<{
    type: z.ZodLiteral<"step.finished">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const MessageStarted: z.ZodObject<{
    type: z.ZodLiteral<"message.started">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        role: z.ZodLiteral<"assistant">;
        continuing: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
/** Appended text. Carries cumulative usage and, if requested, token data. */
export declare const TextDelta: z.ZodObject<{
    type: z.ZodLiteral<"text.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        tokens: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            text: z.ZodString;
            logprob: z.ZodOptional<z.ZodNumber>;
            top: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                text: z.ZodString;
                logprob: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
/** The block's complete text. Replaces whatever was built from deltas. */
export declare const TextEnd: z.ZodObject<{
    type: z.ZodLiteral<"text.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ReasoningDelta: z.ZodObject<{
    type: z.ZodLiteral<"reasoning.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ReasoningEnd: z.ZodObject<{
    type: z.ZodLiteral<"reasoning.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const FinishReason: z.ZodEnum<{
    error: "error";
    length: "length";
    stop: "stop";
    tool_calls: "tool_calls";
    cancelled: "cancelled";
}>;
export type FinishReason = z.infer<typeof FinishReason>;
/** The authoritative final message. Replaces the message built from deltas. */
export declare const MessageFinished: z.ZodObject<{
    type: z.ZodLiteral<"message.finished">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        message: z.ZodObject<{
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
        finishReason: z.ZodEnum<{
            error: "error";
            length: "length";
            stop: "stop";
            tool_calls: "tool_calls";
            cancelled: "cancelled";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ToolCalled: z.ZodObject<{
    type: z.ZodLiteral<"tool.called">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>;
/** A tool call the harness could not parse. Sent back to the model. */
export declare const ToolMalformed: z.ZodObject<{
    type: z.ZodLiteral<"tool.malformed">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ToolApprovalRequested: z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_requested">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ToolApprovalResolved: z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_resolved">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>;
/** Withdraws an open request, for example when its run is cancelled. */
export declare const RequestCancel: z.ZodObject<{
    type: z.ZodLiteral<"request.cancel">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ToolUpdate: z.ZodObject<{
    type: z.ZodLiteral<"tool.update">;
    data: z.ZodObject<{
        callId: z.ZodString;
        partial: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
/** `preview` is truncated and redacted; the full result is stored. */
export declare const ToolResult: z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    data: z.ZodObject<{
        callId: z.ZodString;
        isError: z.ZodBoolean;
        preview: z.ZodString;
        durationMs: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const RunFinished: z.ZodObject<{
    type: z.ZodLiteral<"run.finished">;
    data: z.ZodObject<{
        reason: z.ZodEnum<{
            stop: "stop";
            cancelled: "cancelled";
            iteration_limit: "iteration_limit";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const RunFailed: z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    data: z.ZodObject<{
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
/** The backend stopped while the run was active. */
export declare const RunInterrupted: z.ZodObject<{
    type: z.ZodLiteral<"run.interrupted">;
    data: z.ZodObject<{}, z.core.$strip>;
}, z.core.$strip>;
export declare const EventBody: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    data: z.ZodObject<{
        kind: z.ZodEnum<{
            single: "single";
            loop: "loop";
            pipeline: "pipeline";
        }>;
        parentRunId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.started">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.finished">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.started">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        role: z.ZodLiteral<"assistant">;
        continuing: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        tokens: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            text: z.ZodString;
            logprob: z.ZodOptional<z.ZodNumber>;
            top: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                text: z.ZodString;
                logprob: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.finished">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        message: z.ZodObject<{
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
        finishReason: z.ZodEnum<{
            error: "error";
            length: "length";
            stop: "stop";
            tool_calls: "tool_calls";
            cancelled: "cancelled";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.called">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.malformed">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_requested">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_resolved">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request.cancel">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.update">;
    data: z.ZodObject<{
        callId: z.ZodString;
        partial: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    data: z.ZodObject<{
        callId: z.ZodString;
        isError: z.ZodBoolean;
        preview: z.ZodString;
        durationMs: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.finished">;
    data: z.ZodObject<{
        reason: z.ZodEnum<{
            stop: "stop";
            cancelled: "cancelled";
            iteration_limit: "iteration_limit";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    data: z.ZodObject<{
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.interrupted">;
    data: z.ZodObject<{}, z.core.$strip>;
}, z.core.$strip>], "type">;
export type EventBody = z.infer<typeof EventBody>;
/** An event as emitted by the core. */
export declare const HarnessEvent: z.ZodIntersection<z.ZodObject<{
    runId: z.ZodString;
    sessionId: z.ZodString;
    time: z.ZodString;
}, z.core.$strip>, z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    data: z.ZodObject<{
        kind: z.ZodEnum<{
            single: "single";
            loop: "loop";
            pipeline: "pipeline";
        }>;
        parentRunId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.started">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.finished">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.started">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        role: z.ZodLiteral<"assistant">;
        continuing: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        tokens: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            text: z.ZodString;
            logprob: z.ZodOptional<z.ZodNumber>;
            top: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                text: z.ZodString;
                logprob: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.finished">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        message: z.ZodObject<{
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
        finishReason: z.ZodEnum<{
            error: "error";
            length: "length";
            stop: "stop";
            tool_calls: "tool_calls";
            cancelled: "cancelled";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.called">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.malformed">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_requested">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_resolved">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request.cancel">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.update">;
    data: z.ZodObject<{
        callId: z.ZodString;
        partial: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    data: z.ZodObject<{
        callId: z.ZodString;
        isError: z.ZodBoolean;
        preview: z.ZodString;
        durationMs: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.finished">;
    data: z.ZodObject<{
        reason: z.ZodEnum<{
            stop: "stop";
            cancelled: "cancelled";
            iteration_limit: "iteration_limit";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    data: z.ZodObject<{
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.interrupted">;
    data: z.ZodObject<{}, z.core.$strip>;
}, z.core.$strip>], "type">>;
export type HarnessEvent = z.infer<typeof HarnessEvent>;
/** An event after storage, with its replay ID. */
export declare const StoredEvent: z.ZodIntersection<z.ZodObject<{
    runId: z.ZodString;
    sessionId: z.ZodString;
    time: z.ZodString;
    id: z.ZodNumber;
}, z.core.$strip>, z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    data: z.ZodObject<{
        kind: z.ZodEnum<{
            single: "single";
            loop: "loop";
            pipeline: "pipeline";
        }>;
        parentRunId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.started">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"step.finished">;
    data: z.ZodObject<{
        index: z.ZodNumber;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.started">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        role: z.ZodLiteral<"assistant">;
        continuing: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        tokens: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            text: z.ZodString;
            logprob: z.ZodOptional<z.ZodNumber>;
            top: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                text: z.ZodString;
                logprob: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.delta">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning.end">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.finished">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        message: z.ZodObject<{
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
        finishReason: z.ZodEnum<{
            error: "error";
            length: "length";
            stop: "stop";
            tool_calls: "tool_calls";
            cancelled: "cancelled";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.called">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        contentIndex: z.ZodNumber;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.malformed">;
    data: z.ZodObject<{
        messageId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_requested">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        callId: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodUnknown;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.approval_resolved">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request.cancel">;
    data: z.ZodObject<{
        requestId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.update">;
    data: z.ZodObject<{
        callId: z.ZodString;
        partial: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    data: z.ZodObject<{
        callId: z.ZodString;
        isError: z.ZodBoolean;
        preview: z.ZodString;
        durationMs: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.finished">;
    data: z.ZodObject<{
        reason: z.ZodEnum<{
            stop: "stop";
            cancelled: "cancelled";
            iteration_limit: "iteration_limit";
        }>;
        usage: z.ZodOptional<z.ZodObject<{
            promptTokens: z.ZodNumber;
            completionTokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    data: z.ZodObject<{
        error: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.interrupted">;
    data: z.ZodObject<{}, z.core.$strip>;
}, z.core.$strip>], "type">>;
export type StoredEvent = z.infer<typeof StoredEvent>;
export type EventType = EventBody["type"];
export type EventOf<T extends EventType> = Extract<HarnessEvent, {
    type: T;
}>;
