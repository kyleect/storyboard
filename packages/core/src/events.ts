import { z } from "zod";
import { AssistantMessage, TokenInfo, Usage } from "./messages.js";

/*
 * The streamed event contract (design doc, "Streamed event contract").
 *
 * The core emits events without an `id`. Whoever stores them (the backend)
 * assigns the increasing `id` that is used as the SSE event ID for replay.
 */

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ type: z.literal(type), data });

export const RunKind = z.enum(["single", "loop", "pipeline"]);

/** The agent version a run runs as (agents design, decisions 13 to 15). */
export const RunAgent = z.object({
  id: z.string(),
  /** The name it has in this version. */
  name: z.string(),
  version: z.number().int(),
  /** Null: a global agent. */
  projectId: z.string().nullable(),
});
export type RunAgent = z.infer<typeof RunAgent>;

export const RunStarted = event(
  "run.started",
  z.object({
    kind: RunKind,
    parentRunId: z.string().optional(),
    /** The model name sent to the server, when one is set. */
    model: z.string().optional(),
    /** The reasoning effort sent to the server, when one is set. */
    reasoningEffort: z.string().optional(),
    /** The agent the run runs as, when there is one. */
    agent: RunAgent.optional(),
  }),
);

export const StepStarted = event(
  "step.started",
  z.object({ index: z.number().int(), name: z.string().optional() }),
);
export const StepFinished = event(
  "step.finished",
  z.object({ index: z.number().int(), name: z.string().optional() }),
);

export const MessageStarted = event(
  "message.started",
  z.object({
    messageId: z.string(),
    role: z.literal("assistant"),
    /** True when an existing message is being continued. */
    continuing: z.boolean().optional(),
  }),
);

/** Appended text. Carries cumulative usage and, if requested, token data. */
export const TextDelta = event(
  "text.delta",
  z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
    tokens: z.array(TokenInfo).optional(),
    usage: Usage.optional(),
  }),
);

/** The block's complete text. Replaces whatever was built from deltas. */
export const TextEnd = event(
  "text.end",
  z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
  }),
);

export const ReasoningDelta = event(
  "reasoning.delta",
  z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
    usage: Usage.optional(),
  }),
);

export const ReasoningEnd = event(
  "reasoning.end",
  z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    text: z.string(),
  }),
);

export const FinishReason = z.enum([
  "stop",
  "length",
  "tool_calls",
  "cancelled",
  "error",
]);
export type FinishReason = z.infer<typeof FinishReason>;

/** The authoritative final message. Replaces the message built from deltas. */
export const MessageFinished = event(
  "message.finished",
  z.object({
    messageId: z.string(),
    message: AssistantMessage,
    finishReason: FinishReason,
    usage: Usage.optional(),
  }),
);

export const ToolCalled = event(
  "tool.called",
  z.object({
    messageId: z.string(),
    contentIndex: z.number().int(),
    callId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
);

/** A tool call the harness could not parse. Sent back to the model. */
export const ToolMalformed = event(
  "tool.malformed",
  z.object({
    messageId: z.string(),
    callId: z.string(),
    name: z.string(),
    error: z.string(),
    /**
     * Set in an agent loop, where the call is kept in the message (with its
     * raw `arguments` string) so it can be returned to the model.
     */
    contentIndex: z.number().int().optional(),
    arguments: z.string().optional(),
  }),
);

export const ToolApprovalRequested = event(
  "tool.approval_requested",
  z.object({
    requestId: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
);

/**
 * The user's answer to an approval request: allow once, allow for this
 * session, always allow this tool, or deny (tools design 6.5).
 */
export const ApprovalChoice = z.enum(["once", "session", "always", "deny"]);
export type ApprovalChoice = z.infer<typeof ApprovalChoice>;

/** The choices that can carry a note (approval notes design, D2). */
export const NOTE_CHOICES: readonly ApprovalChoice[] = ["once", "deny"];

/** The user's answer, with the note typed on the prompt, if any. */
export interface ApprovalAnswer {
  choice: ApprovalChoice;
  note?: string;
}

export const ToolApprovalResolved = event(
  "tool.approval_resolved",
  z.object({
    requestId: z.string(),
    choice: ApprovalChoice,
    note: z.string().optional(),
  }),
);

/** Withdraws an open request, for example when its run is cancelled. */
export const RequestCancel = event(
  "request.cancel",
  z.object({ requestId: z.string(), reason: z.string() }),
);

export const ToolUpdate = event(
  "tool.update",
  z.object({ callId: z.string(), partial: z.string() }),
);

/**
 * A tool call's outcome. `messageId` is the tool result message, which is
 * stored before this event is sent. `preview` is truncated; the full result
 * is in that message. `error` is the full error text when the text sent to
 * the model was shortened.
 */
export const ToolResult = event(
  "tool.result",
  z.object({
    messageId: z.string(),
    callId: z.string(),
    name: z.string(),
    isError: z.boolean(),
    preview: z.string(),
    durationMs: z.number(),
    error: z.string().optional(),
  }),
);

export const RunFinished = event(
  "run.finished",
  z.object({
    reason: z.enum(["stop", "iteration_limit", "cancelled"]),
    usage: Usage.optional(),
  }),
);

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
export type EventBody = z.infer<typeof EventBody>;

/*
 * Session events belong to a session but to no run; their envelope's
 * `runId` is null (sessions and projects design, Q7b).
 */

/** The session was moved to the trash. */
export const SessionTrashed = event("session.trashed", z.object({}));

/**
 * The user changed session-scoped files or memory notes in the app; the
 * change is recorded in the edit message `messageId` (files and memory
 * design, decision 11).
 */
export const SessionEntriesChanged = event(
  "session.entries_changed",
  z.object({ messageId: z.string() }),
);

export const SessionEventBody = z.discriminatedUnion("type", [
  SessionTrashed,
  SessionEntriesChanged,
]);
export type SessionEventBody = z.infer<typeof SessionEventBody>;

const Envelope = z.object({
  runId: z.string(),
  sessionId: z.string(),
  /** ISO 8601 timestamp. */
  time: z.string(),
});

const SessionEnvelope = Envelope.extend({ runId: z.null() });

/** An event as emitted by the core (run events) or the backend. */
export const HarnessEvent = z.union([
  z.intersection(Envelope, EventBody),
  z.intersection(SessionEnvelope, SessionEventBody),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;

/** An event that belongs to a run. */
export type RunEvent = Extract<HarnessEvent, { runId: string }>;

/** An event after storage, with its replay ID. */
export const StoredEvent = z.union([
  z.intersection(Envelope.extend({ id: z.number().int() }), EventBody),
  z.intersection(
    SessionEnvelope.extend({ id: z.number().int() }),
    SessionEventBody,
  ),
]);
export type StoredEvent = z.infer<typeof StoredEvent>;

export type EventType = HarnessEvent["type"];
export type EventOf<T extends EventType> = Extract<HarnessEvent, { type: T }>;
