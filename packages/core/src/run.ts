import type {
  EventBody,
  FinishReason,
  HarnessEvent,
  RunAgent,
} from "./events.js";
import type { AssistantMessage, ContentBlock, Usage } from "./messages.js";
import type { ChatRequest, ModelAdapter } from "./model.js";

export interface RunContext {
  runId: string;
  sessionId: string;
  emit: (event: HarnessEvent) => void;
  signal: AbortSignal;
  parentRunId?: string;
  /** The agent the run runs as; reported in `run.started`. */
  agent?: RunAgent;
  /** Defaults to the current time as ISO 8601. */
  now?: () => string;
  /** Defaults to random UUIDs. */
  newId?: () => string;
  /**
   * Continue an existing assistant message instead of starting a new one.
   * The request should end with that message (assistant prefill). New text
   * is appended to its last block when that block is text.
   */
  continueMessage?: { messageId: string; message: AssistantMessage };
  /** The id for a new message. Defaults to `newId()`. */
  messageId?: string;
}

export interface SingleCallResult {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage?: Usage;
  /** Tool calls whose arguments could not be parsed. Not in `message`. */
  malformed: { callId: string; name: string; error: string }[];
}

/**
 * Runs one model request and emits the run's events.
 * Tool calls are reported, not executed.
 * Never throws for model errors: they end the run with `run.failed`.
 */
export async function runSingleCall(
  model: ModelAdapter,
  request: ChatRequest,
  ctx: RunContext,
): Promise<SingleCallResult> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const emit = emitter(ctx, now);

  const continuing = ctx.continueMessage;
  emit({
    type: "run.started",
    data: {
      kind: "single",
      ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
      ...(ctx.agent ? { agent: ctx.agent } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
    },
  });

  const step = await streamMessage(model, request, {
    emit,
    signal: ctx.signal,
    messageId: continuing?.messageId ?? ctx.messageId ?? newId(),
    ...(continuing ? { continuing: continuing.message } : {}),
    keepMalformed: false,
  });

  if (step.failure !== undefined) {
    emit({ type: "run.failed", data: { error: step.failure } });
  } else {
    emit({
      type: "run.finished",
      data: {
        reason: step.finishReason === "cancelled" ? "cancelled" : "stop",
        ...(step.usage ? { usage: step.usage } : {}),
      },
    });
  }

  return {
    message: step.message,
    finishReason: step.finishReason,
    ...(step.usage ? { usage: step.usage } : {}),
    malformed: step.malformed,
  };
}

/** Adds the envelope (run, session, time) to event bodies. */
export function emitter(
  ctx: Pick<RunContext, "runId" | "sessionId" | "emit">,
  now: () => string,
): (body: EventBody) => void {
  return (body) =>
    ctx.emit({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      time: now(),
      ...body,
    } as HarnessEvent);
}

export interface StreamOptions {
  emit: (body: EventBody) => void;
  signal: AbortSignal;
  messageId: string;
  /** Continue this message (assistant prefill) instead of starting one. */
  continuing?: AssistantMessage;
  /**
   * Keep calls with invalid JSON in the message, with the raw argument
   * string, so they can be returned to the model (agent loop).
   */
  keepMalformed: boolean;
  /**
   * Called with the final message just before `message.finished`, with the
   * usage that event carries.
   */
  beforeFinished?: (
    message: AssistantMessage,
    reason: FinishReason,
    usage: Usage | undefined,
  ) => void;
}

export interface StreamResult extends SingleCallResult {
  /** Set when the model request failed. */
  failure?: string;
}

/**
 * Streams one model response into one assistant message, from
 * `message.started` to `message.finished`. Never throws for model errors.
 */
export async function streamMessage(
  model: ModelAdapter,
  request: ChatRequest,
  opts: StreamOptions,
): Promise<StreamResult> {
  const { emit, messageId } = opts;
  const blocks: ContentBlock[] = opts.continuing
    ? structuredClone(opts.continuing.content)
    : [];
  const malformed: SingleCallResult["malformed"] = [];
  let open: { type: "text" | "reasoning"; index: number; text: string } | null =
    null;
  const last = blocks.at(-1);
  if (last?.type === "text") {
    open = { type: "text", index: blocks.length - 1, text: last.text };
  }
  let usage: Usage | undefined;
  let finishReason: FinishReason = "stop";
  let failure: string | undefined;

  const closeOpen = () => {
    if (!open) return;
    blocks[open.index] = { type: open.type, text: open.text };
    emit({
      type: open.type === "text" ? "text.end" : "reasoning.end",
      data: { messageId, contentIndex: open.index, text: open.text },
    });
    open = null;
  };

  const openBlock = (type: "text" | "reasoning") => {
    if (open?.type === type) return open;
    closeOpen();
    const index = blocks.length;
    blocks.push({ type, text: "" });
    open = { type, index, text: "" };
    return open;
  };

  emit({
    type: "message.started",
    data: {
      messageId,
      role: "assistant",
      ...(opts.continuing ? { continuing: true } : {}),
    },
  });

  try {
    for await (const chunk of model.stream(request, opts.signal)) {
      if (opts.signal.aborted) break;
      switch (chunk.type) {
        case "text": {
          const block = openBlock("text");
          block.text += chunk.text;
          emit({
            type: "text.delta",
            data: {
              messageId,
              contentIndex: block.index,
              text: chunk.text,
              ...(chunk.tokens ? { tokens: chunk.tokens } : {}),
              ...(usage ? { usage } : {}),
            },
          });
          break;
        }
        case "reasoning": {
          const block = openBlock("reasoning");
          block.text += chunk.text;
          emit({
            type: "reasoning.delta",
            data: {
              messageId,
              contentIndex: block.index,
              text: chunk.text,
              ...(usage ? { usage } : {}),
            },
          });
          break;
        }
        case "tool_call": {
          closeOpen();
          let args: unknown;
          try {
            args = JSON.parse(chunk.arguments === "" ? "{}" : chunk.arguments);
          } catch (err) {
            const error = `Invalid JSON in tool arguments: ${(err as Error).message}`;
            malformed.push({ callId: chunk.callId, name: chunk.name, error });
            if (opts.keepMalformed) {
              const index = blocks.length;
              blocks.push({
                type: "tool_call",
                callId: chunk.callId,
                name: chunk.name,
                arguments: chunk.arguments,
              });
              emit({
                type: "tool.malformed",
                data: {
                  messageId,
                  callId: chunk.callId,
                  name: chunk.name,
                  error,
                  contentIndex: index,
                  arguments: chunk.arguments,
                },
              });
            } else {
              emit({
                type: "tool.malformed",
                data: {
                  messageId,
                  callId: chunk.callId,
                  name: chunk.name,
                  error,
                },
              });
            }
            break;
          }
          const index = blocks.length;
          blocks.push({
            type: "tool_call",
            callId: chunk.callId,
            name: chunk.name,
            arguments: args,
          });
          emit({
            type: "tool.called",
            data: {
              messageId,
              contentIndex: index,
              callId: chunk.callId,
              name: chunk.name,
              arguments: args,
            },
          });
          break;
        }
        case "usage":
          usage = chunk.usage;
          break;
        case "finish":
          finishReason = chunk.reason;
          break;
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (failure !== undefined) finishReason = "error";
  else if (opts.signal.aborted) finishReason = "cancelled";

  closeOpen();
  const message: AssistantMessage = { role: "assistant", content: blocks };
  opts.beforeFinished?.(message, finishReason, usage);
  emit({
    type: "message.finished",
    data: { messageId, message, finishReason, ...(usage ? { usage } : {}) },
  });

  return {
    message,
    finishReason,
    ...(usage ? { usage } : {}),
    malformed,
    ...(failure !== undefined ? { failure } : {}),
  };
}
