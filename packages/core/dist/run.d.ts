import type { FinishReason, HarnessEvent } from "./events.js";
import type { AssistantMessage, Usage } from "./messages.js";
import type { ChatRequest, ModelAdapter } from "./model.js";
export interface RunContext {
    runId: string;
    sessionId: string;
    emit: (event: HarnessEvent) => void;
    signal: AbortSignal;
    parentRunId?: string;
    /** Defaults to the current time as ISO 8601. */
    now?: () => string;
    /** Defaults to random UUIDs. */
    newId?: () => string;
    /**
     * Continue an existing assistant message instead of starting a new one.
     * The request should end with that message (assistant prefill). New text
     * is appended to its last block when that block is text.
     */
    continueMessage?: {
        messageId: string;
        message: AssistantMessage;
    };
    /** The id for a new message. Defaults to `newId()`. */
    messageId?: string;
}
export interface SingleCallResult {
    message: AssistantMessage;
    finishReason: FinishReason;
    usage?: Usage;
    /** Tool calls whose arguments could not be parsed. Not in `message`. */
    malformed: {
        callId: string;
        name: string;
        error: string;
    }[];
}
/**
 * Runs one model request and emits the run's events.
 * Tool calls are reported, not executed.
 * Never throws for model errors: they end the run with `run.failed`.
 */
export declare function runSingleCall(model: ModelAdapter, request: ChatRequest, ctx: RunContext): Promise<SingleCallResult>;
