import {
  createEntryAccess,
  replaySessionEntries,
  type EntrySearch,
  type SharedEntries,
} from "./entries.js";
import type { ApprovalChoice } from "./events.js";
import type {
  AssistantMessage,
  ContentBlock,
  EntryOp,
  Message,
  ToolResultMessage,
  Usage,
} from "./messages.js";
import type { ChatRequest, ModelAdapter } from "./model.js";
import { emitter, streamMessage, type RunContext } from "./run.js";
import {
  latestToolState,
  serializeResult,
  toolDefinitions,
  ToolRunError,
  truncate,
  type Tool,
} from "./tools.js";

/*
 * The agent loop (tools design 5.3): call the model, run the tools it calls
 * one after another (6.9), and repeat until it stops calling tools or the
 * iteration limit is reached.
 */

export interface ApprovalRequest {
  requestId: string;
  callId: string;
  name: string;
  arguments: unknown;
}

export interface LoopContext extends RunContext {
  tools: readonly Tool[];
  /** The most model calls one run makes. */
  maxIterations: number;
  /** Whether a call to this tool needs approval. Default: the tool's own. */
  needsApproval?: (tool: Tool) => boolean;
  /**
   * Waits for the user's answer to an approval request, for as long as it
   * takes (6.5). When `signal` aborts, the loop stops waiting on its own;
   * the implementation should drop the request then.
   */
  approve: (
    request: ApprovalRequest,
    signal: AbortSignal,
  ) => Promise<ApprovalChoice>;
  /**
   * Called with each complete message before its event is sent: an
   * assistant message before `message.finished` (only when it has
   * content), a tool result before `tool.result`. For an assistant message,
   * `usage` is the model call's, as `message.finished` carries it; a tool
   * result has none.
   */
  onMessage?: (
    messageId: string,
    message: AssistantMessage | ToolResultMessage,
    usage?: Usage,
  ) => void;
  /** Error text sent to the model is cut to this length. Default 2,000. */
  errorLimit?: number;
  /** `tool.result` previews are cut to this length. Default 500. */
  previewLimit?: number;
  /**
   * The error text for calls not run because the signal aborted. Undefined
   * or left out: "Not run: the run was cancelled."
   */
  cancelledText?: () => string | undefined;
  /** The session's project; null or left out for a standalone session. */
  projectId?: string | null;
  /**
   * Project and global files and notes. Left out: tools see session scope
   * only.
   */
  sharedEntries?: SharedEntries;
  /** Generates memory note ids. Default: 8 random hex digits. */
  newNoteId?: () => string;
  /** Searches files and notes. Left out: the search tools fail. */
  searchEntries?: EntrySearch;
}

export type LoopEnd = "stop" | "iteration_limit" | "cancelled" | "failed";

export interface LoopResult {
  reason: LoopEnd;
  usage?: Usage;
  /** Why the run failed, when `reason` is "failed". */
  error?: string;
}

export const DEFAULT_ERROR_LIMIT = 2000;
export const DEFAULT_PREVIEW_LIMIT = 500;

const CANCELLED = "Not run: the run was cancelled.";
const FAILED = "Not run: the run failed.";
const TRUNCATED =
  "Not run: the response was cut off at the token limit, so the arguments may be incomplete.";

/**
 * Runs an agent loop and emits its events. `request.messages` is the
 * transcript; the loop sets `request.tools` from `ctx.tools`.
 * Never throws for model or tool errors.
 */
export async function runLoop(
  model: ModelAdapter,
  request: ChatRequest,
  ctx: LoopContext,
): Promise<LoopResult> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const emit = emitter(ctx, now);
  const errorLimit = ctx.errorLimit ?? DEFAULT_ERROR_LIMIT;
  const previewLimit = ctx.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const needsApproval =
    ctx.needsApproval ?? ((tool: Tool) => tool.approval === "ask");
  const definitions = toolDefinitions(ctx.tools);
  const notRun = () => ctx.cancelledText?.() ?? CANCELLED;
  const transcript: Message[] = [...request.messages];
  let usage: Usage | undefined;

  const finish = (result: LoopResult): LoopResult => {
    const withUsage = { ...result, ...(usage ? { usage } : {}) };
    if (result.reason === "failed") {
      emit({ type: "run.failed", data: { error: result.error ?? "" } });
    } else {
      emit({
        type: "run.finished",
        data: { reason: result.reason, ...(usage ? { usage } : {}) },
      });
    }
    return withUsage;
  };

  /** Stores a tool result and sends `tool.result`. */
  const addResult = (
    call: ToolCall,
    result: {
      content: string;
      isError: boolean;
      data?: unknown;
      state?: unknown;
      entries?: EntryOp[];
      error?: string;
      durationMs?: number;
    },
  ) => {
    const messageId = newId();
    const message: ToolResultMessage = {
      role: "tool",
      callId: call.callId,
      name: call.name,
      content: result.content,
      isError: result.isError,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.state !== undefined ? { state: result.state } : {}),
      ...(result.entries?.length ? { entries: result.entries } : {}),
    };
    ctx.onMessage?.(messageId, message);
    transcript.push(message);
    emit({
      type: "tool.result",
      data: {
        messageId,
        callId: call.callId,
        name: call.name,
        isError: result.isError,
        preview: truncate(result.content, previewLimit),
        durationMs: result.durationMs ?? 0,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    });
  };

  /** An error result; text longer than the limit is cut, the full kept. */
  const addError = (call: ToolCall, text: string, durationMs?: number) => {
    const content = truncate(text, errorLimit);
    addResult(call, {
      content,
      isError: true,
      ...(content !== text ? { error: text } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  };

  emit({
    type: "run.started",
    data: {
      kind: "loop",
      ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
    },
  });

  for (let index = 0; ; index++) {
    if (index >= ctx.maxIterations)
      return finish({ reason: "iteration_limit" });
    emit({ type: "step.started", data: { index } });

    const continuing = index === 0 ? ctx.continueMessage : undefined;
    const messageId =
      continuing?.messageId ??
      (index === 0 && ctx.messageId ? ctx.messageId : newId());
    const step = await streamMessage(
      model,
      { ...request, messages: [...transcript], tools: definitions },
      {
        emit,
        signal: ctx.signal,
        messageId,
        ...(continuing ? { continuing: continuing.message } : {}),
        keepMalformed: true,
        beforeFinished: (message, _reason, usage) => {
          if (message.content.length > 0)
            ctx.onMessage?.(messageId, message, usage);
        },
      },
    );
    usage = addUsage(usage, step.usage);
    if (continuing) {
      // The request ended with the continued message (prefill).
      transcript[transcript.length - 1] = step.message;
    } else if (step.message.content.length > 0) {
      transcript.push(step.message);
    }

    // Only calls from this response; a continued message had none.
    const calls = step.message.content
      .slice(continuing ? continuing.message.content.length : 0)
      .filter(isToolCall);
    const malformed = new Map(step.malformed.map((m) => [m.callId, m.error]));

    if (step.failure !== undefined) {
      for (const call of calls) addError(call, FAILED);
      emit({ type: "step.finished", data: { index } });
      return finish({ reason: "failed", error: step.failure });
    }
    if (calls.length === 0) {
      emit({ type: "step.finished", data: { index } });
      return finish({ reason: ctx.signal.aborted ? "cancelled" : "stop" });
    }

    let failed: string | undefined;
    for (const call of calls) {
      if (failed !== undefined || ctx.signal.aborted) {
        addError(call, failed !== undefined ? FAILED : notRun());
        continue;
      }
      if (step.finishReason === "length") {
        addError(call, TRUNCATED);
        continue;
      }
      failed = await runCall(call, malformed.get(call.callId));
    }
    emit({ type: "step.finished", data: { index } });
    if (failed !== undefined)
      return finish({ reason: "failed", error: failed });
    if (ctx.signal.aborted) return finish({ reason: "cancelled" });
  }

  /** Runs one call and adds its result. Returns an error to fail the run. */
  async function runCall(
    call: ToolCall,
    malformedError: string | undefined,
  ): Promise<string | undefined> {
    if (malformedError !== undefined) {
      addError(call, malformedError);
      return;
    }
    const tool = ctx.tools.find((t) => t.name === call.name);
    if (!tool) {
      addError(call, `Unknown tool "${call.name}".`);
      return;
    }
    const parsed = tool.parse(call.arguments);
    if (!parsed.ok) {
      addError(call, `Invalid arguments for ${tool.name}:\n${parsed.error}`);
      return;
    }

    if (needsApproval(tool)) {
      const requestId = newId();
      emit({
        type: "tool.approval_requested",
        data: {
          requestId,
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        },
      });
      let choice: ApprovalChoice | undefined;
      try {
        choice = await untilAborted(
          ctx.approve(
            {
              requestId,
              callId: call.callId,
              name: call.name,
              arguments: call.arguments,
            },
            ctx.signal,
          ),
          ctx.signal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          type: "request.cancel",
          data: { requestId, reason: message },
        });
        addError(call, `Not run: the approval failed: ${message}`);
        return;
      }
      if (choice === undefined) {
        emit({
          type: "request.cancel",
          data: { requestId, reason: "The run was cancelled." },
        });
        addError(call, notRun());
        return;
      }
      emit({ type: "tool.approval_resolved", data: { requestId, choice } });
      if (choice === "deny") {
        addError(call, "The user denied this tool call.");
        return;
      }
    }

    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const sessionOps: EntryOp[] = [];
    try {
      const entries = createEntryAccess({
        session: replaySessionEntries(transcript),
        sessionOps,
        ...(ctx.sharedEntries ? { shared: ctx.sharedEntries } : {}),
        inProject: (ctx.projectId ?? null) !== null,
        author: { by: "model", sessionId: ctx.sessionId, runId: ctx.runId },
        ...(ctx.newNoteId ? { newNoteId: ctx.newNoteId } : {}),
        ...(ctx.searchEntries
          ? {
              search: (q) =>
                (ctx.searchEntries as EntrySearch)({
                  ...q,
                  signal: ctx.signal,
                }),
            }
          : {}),
      });
      const output = await tool.execute(parsed.input, {
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        callId: call.callId,
        update: (partial) =>
          emit({ type: "tool.update", data: { callId: call.callId, partial } }),
        state: latestToolState(transcript, tool.name),
        projectId: ctx.projectId ?? null,
        entries,
      });
      const text = serializeResult(output.data);
      const content = output.isError ? truncate(text, errorLimit) : text;
      addResult(call, {
        content,
        isError: output.isError ?? false,
        data: output.data,
        ...(output.state !== undefined ? { state: output.state } : {}),
        // Session-scoped changes count only when the tool succeeded.
        ...(output.isError ? {} : { entries: sessionOps }),
        ...(content !== text ? { error: text } : {}),
        durationMs: elapsed(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ToolRunError) {
        addError(call, message, elapsed());
        return message;
      }
      addError(
        call,
        ctx.signal.aborted ? notRun() : `${tool.name} failed: ${message}`,
        elapsed(),
      );
    }
  }
}

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>;

const isToolCall = (b: ContentBlock): b is ToolCall => b.type === "tool_call";

function addUsage(
  a: Usage | undefined,
  b: Usage | undefined,
): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

/** Settles with the promise's value, or undefined when the signal aborts. */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
