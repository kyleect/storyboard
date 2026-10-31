import { z } from "zod";
import { AssistantMessage, TokenInfo, Usage } from "./messages.js";
/*
 * The streamed event contract (design doc, "Streamed event contract").
 *
 * The core emits events without an `id`. Whoever stores them (the backend)
 * assigns the increasing `id` that is used as the SSE event ID for replay.
 */
const event = (type, data) => z.object({ type: z.literal(type), data });
export const RunKind = z.enum(["single", "loop", "pipeline"]);
export const RunStarted = event("run.started", z.object({
    kind: RunKind,
    parentRunId: z.string().optional(),
}));
export const StepStarted = event("step.started", z.object({ index: z.number().int(), name: z.string().optional() }));
export const StepFinished = event("step.finished", z.object({ index: z.number().int(), name: z.string().optional() }));
export const MessageStarted = event("message.started", z.object({
    messageId: z.string(),
    role: z.literal("assistant"),
    /** True when an existing message is being continued. */
    continuing: z.boolean().optional(),
}));
/** Appended text. Carries cumulative usage and, if requested, token data. */
export const TextDelta = event("text.delta", z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
    tokens: z.array(TokenInfo).optional(),
    usage: Usage.optional(),
}));
/** The block's complete text. Replaces whatever was built from deltas. */
export const TextEnd = event("text.end", z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
}));
export const ReasoningDelta = event("reasoning.delta", z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
    usage: Usage.optional(),
}));
export const ReasoningEnd = event("reasoning.end", z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
}));
export const FinishReason = z.enum([
    "stop",
    "length",
    "tool_calls",
    "cancelled",
    "error",
]);
/** The authoritative final message. Replaces the message built from deltas. */
export const MessageFinished = event("message.finished", z.object({
    messageId: z.string(),
    message: AssistantMessage,
    finishReason: FinishReason,
    usage: Usage.optional(),
}));
export const ToolCalled = event("tool.called", z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    callId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
}));
/** A tool call the harness could not parse. Sent back to the model. */
export const ToolMalformed = event("tool.malformed", z.object({
    messageId: z.string(),
    callId: z.string(),
    name: z.string(),
    error: z.string(),
}));
export const ToolApprovalRequested = event("tool.approval_requested", z.object({
    requestId: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
}));
export const ToolApprovalResolved = event("tool.approval_resolved", z.object({ requestId: z.string(), approved: z.boolean() }));
/** Withdraws an open request, for example when its run is cancelled. */
export const RequestCancel = event("request.cancel", z.object({ requestId: z.string(), reason: z.string() }));
export const ToolUpdate = event("tool.update", z.object({ callId: z.string(), partial: z.string() }));
/** `preview` is truncated and redacted; the full result is stored. */
export const ToolResult = event("tool.result", z.object({
    callId: z.string(),
    isError: z.boolean(),
    preview: z.string(),
    durationMs: z.number(),
}));
export const RunFinished = event("run.finished", z.object({
    reason: z.enum(["stop", "iteration_limit", "cancelled"]),
    usage: Usage.optional(),
}));
export const RunFailed = event("run.failed", z.object({ error: z.string() }));
/** The backend stopped while the run was active. */
export const RunInterrupted = event("run.interrupted", z.object({}));
export const EventBody = z.discriminatedUnion("type", [
    RunStarted,
    StepStarted,
    StepFinished,
    MessageStarted,
    TextDelta,
    TextEnd,
    ReasoningDelta,
    ReasoningEnd,
    MessageFinished,
    ToolCalled,
    ToolMalformed,
    ToolApprovalRequested,
    ToolApprovalResolved,
    RequestCancel,
    ToolUpdate,
    ToolResult,
    RunFinished,
    RunFailed,
    RunInterrupted,
]);
const Envelope = z.object({
    runId: z.string(),
    sessionId: z.string(),
    /** ISO 8601 timestamp. */
    time: z.string(),
});
/** An event as emitted by the core. */
export const HarnessEvent = z.intersection(Envelope, EventBody);
/** An event after storage, with its replay ID. */
export const StoredEvent = z.intersection(Envelope.extend({ id: z.number().int() }), EventBody);
//# sourceMappingURL=events.js.map