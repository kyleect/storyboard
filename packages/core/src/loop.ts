import {
  createEntryAccess,
  replaySessionEntries,
  type EntrySearch,
  type SharedEntries,
} from "./entries.js";
import type { ApprovalAnswer, InputRequest } from "./events.js";
import { ASK_USER, DECLINED, type Form, type InputAnswer } from "./forms.js";
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
  ToolError,
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

/** What went wrong in a reported tool call (error reporting plan, P2). */
export type ToolErrorKind =
  | "tool_threw"
  | "tool_returned_error"
  | "unknown_tool"
  | "invalid_arguments"
  | "malformed_call";

/** A tool error, for the errors console (error reporting plan, P2). */
export interface ToolErrorReport {
  kind: ToolErrorKind;
  callId: string;
  toolName: string;
  /** The tool result message that holds the error. */
  messageId: string;
  /** The full error text: what the model got, before it was cut. */
  message: string;
  /** What the tool gave (`ToolOutput.details` or `ToolError.details`). */
  details?: Record<string, unknown>;
  /** The stack trace, for a thrown error. */
  stack?: string;
  /** The call's arguments; the raw text for a malformed call. */
  arguments: unknown;
  /** True when the error ends the run (`ToolRunError`). */
  endsRun: boolean;
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
   * the implementation should drop the request then. A note is kept only
   * with "once" and "deny".
   */
  approve: (
    request: ApprovalRequest,
    signal: AbortSignal,
  ) => Promise<ApprovalAnswer>;
  /**
   * Waits for the user's answer to a form a tool shows (input forms design),
   * for as long as it takes. When `signal` aborts, the loop stops waiting on
   * its own; the implementation should drop the request then. Left out:
   * tools that ask fail.
   */
  requestInput?: (
    request: InputRequest,
    signal: AbortSignal,
  ) => Promise<InputAnswer>;
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
  /**
   * Called for each tool error worth showing in the errors console, after
   * its tool result is stored: a tool threw or returned an error (except
   * an `ask_user` form the user declined or skipped), an unknown tool, invalid arguments or
   * a malformed call. Not for denied calls or calls not run.
   */
  reportError?: (report: ToolErrorReport) => void;
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

  /** Stores a tool result and sends `tool.result`. Returns its id. */
  const addResult = (
    call: ToolCall,
    result: {
      content: string;
      isError: boolean;
      data?: unknown;
      state?: unknown;
      entries?: EntryOp[];
      note?: ToolResultMessage["note"];
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
      ...(result.note ? { note: result.note } : {}),
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
    return messageId;
  };

  /**
   * An error result; text longer than the limit is cut, the full kept.
   * Returns its message id.
   */
  const addError = (
    call: ToolCall,
    text: string,
    durationMs?: number,
    note?: ToolResultMessage["note"],
  ) => {
    const content = truncate(text, errorLimit);
    return addResult(call, {
      content,
      isError: true,
      ...(content !== text ? { error: text } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(note ? { note } : {}),
    });
  };

  emit({
    type: "run.started",
    data: {
      kind: "loop",
      ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
      ...(ctx.agent ? { agent: ctx.agent } : {}),
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

  /**
   * Shows a form for a call and waits for the answer. Throws when the run is
   * cancelled (the tool's result then says it was not run) or the run
   * cannot ask.
   */
  async function requestInput(
    call: ToolCall,
    form: Form,
  ): Promise<InputAnswer> {
    if (!ctx.requestInput) {
      throw new Error("This run cannot ask the user for input.");
    }
    const request: InputRequest = {
      requestId: newId(),
      callId: call.callId,
      form,
    };
    emit({ type: "input.requested", data: request });
    let answer: InputAnswer | undefined;
    try {
      answer = await untilAborted(
        ctx.requestInput(request, ctx.signal),
        ctx.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "request.cancel",
        data: { requestId: request.requestId, reason: message },
      });
      throw err;
    }
    if (answer === undefined) {
      emit({
        type: "request.cancel",
        data: {
          requestId: request.requestId,
          reason: "The run was cancelled.",
        },
      });
      throw new Error("The run was cancelled.");
    }
    emit({
      type: "input.resolved",
      data: { requestId: request.requestId, outcome: answer.outcome },
    });
    return answer;
  }

  /** Runs one call and adds its result. Returns an error to fail the run. */
  async function runCall(
    call: ToolCall,
    malformedError: string | undefined,
  ): Promise<string | undefined> {
    /** Adds an error result and reports it. */
    const addReported = (
      kind: ToolErrorKind,
      text: string,
      extra: {
        durationMs?: number;
        note?: ToolResultMessage["note"];
        details?: Record<string, unknown> | undefined;
        stack?: string | undefined;
        endsRun?: boolean;
      } = {},
    ) => {
      const messageId = addError(call, text, extra.durationMs, extra.note);
      report(kind, messageId, text, extra);
    };
    const report = (
      kind: ToolErrorKind,
      messageId: string,
      text: string,
      extra: {
        details?: Record<string, unknown> | undefined;
        stack?: string | undefined;
        endsRun?: boolean;
      },
    ) => {
      ctx.reportError?.({
        kind,
        callId: call.callId,
        toolName: call.name,
        messageId,
        message: text,
        ...(extra.details !== undefined ? { details: extra.details } : {}),
        ...(extra.stack !== undefined ? { stack: extra.stack } : {}),
        arguments: call.arguments,
        endsRun: extra.endsRun ?? false,
      });
    };

    if (malformedError !== undefined) {
      addReported("malformed_call", malformedError);
      return;
    }
    const tool = ctx.tools.find((t) => t.name === call.name);
    // The user's note from the approval prompt, kept on the call's result.
    let note: ToolResultMessage["note"];
    if (!tool) {
      addReported("unknown_tool", `Unknown tool "${call.name}".`);
      return;
    }
    const parsed = tool.parse(call.arguments);
    if (!parsed.ok) {
      addReported(
        "invalid_arguments",
        `Invalid arguments for ${tool.name}:\n${parsed.error}`,
      );
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
      let answer: ApprovalAnswer | undefined;
      try {
        answer = await untilAborted(
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
      if (answer === undefined) {
        emit({
          type: "request.cancel",
          data: { requestId, reason: "The run was cancelled." },
        });
        addError(call, notRun());
        return;
      }
      const { choice } = answer;
      const text =
        choice === "once" || choice === "deny" ? answer.note?.trim() : "";
      emit({
        type: "tool.approval_resolved",
        data: { requestId, choice, ...(text ? { note: text } : {}) },
      });
      if (text) note = { text, choice: choice === "deny" ? "deny" : "once" };
      if (choice === "deny") {
        addError(call, "The user denied this tool call.", undefined, note);
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
        requestInput: (form) => requestInput(call, form),
      });
      const text = serializeResult(output.data);
      const content = output.isError ? truncate(text, errorLimit) : text;
      const messageId = addResult(call, {
        content,
        isError: output.isError ?? false,
        data: output.data,
        ...(output.state !== undefined ? { state: output.state } : {}),
        // Session-scoped changes count only when the tool succeeded.
        ...(output.isError ? {} : { entries: sessionOps }),
        ...(content !== text ? { error: text } : {}),
        ...(note ? { note } : {}),
        durationMs: elapsed(),
      });
      // A declined or skipped form is the user's choice, not an error (O1).
      const declined = tool.name === ASK_USER && output.data === DECLINED;
      if (output.isError && !declined) {
        report("tool_returned_error", messageId, text, {
          details: output.details,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const thrown = {
        durationMs: elapsed(),
        note,
        details: err instanceof ToolError ? err.details : undefined,
        stack: err instanceof Error ? err.stack : undefined,
      };
      if (err instanceof ToolRunError) {
        addReported("tool_threw", message, { ...thrown, endsRun: true });
        return message;
      }
      if (ctx.signal.aborted) {
        addError(call, notRun(), elapsed(), note);
        return;
      }
      addReported("tool_threw", `${tool.name} failed: ${message}`, thrown);
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
