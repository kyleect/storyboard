import {
  createFileAccess,
  replaySessionFiles,
  type FileSearch,
  type SharedFiles,
} from "./files.js";
import type { ApprovalAnswer, InputRequest } from "./events.js";
import type { Review, Selection } from "./review.js";
import {
  createDataAccess,
  NO_DATA,
  replaySessionData,
  type SchemaChecker,
  type SharedData,
} from "./schemas-data.js";
import {
  ASK_USER,
  DECLINED,
  describePrompt,
  type Form,
  type InputAnswer,
  type PromptRecord,
} from "./forms.js";
import type {
  AssistantMessage,
  ContentBlock,
  DataOp,
  FileOp,
  MediaRef,
  Message,
  ToolResultMessage,
  UserMessage,
  Usage,
} from "./messages.js";
import type { MediaSupport } from "./media.js";
import type { ApprovalSubject, WorkspaceAccess } from "./workspaces.js";
import type { ChatRequest, ModelAdapter } from "./model.js";
import { emitter, streamMessage, type RunContext } from "./run.js";
import {
  latestToolState,
  NO_SKILL_FILES,
  serializeResult,
  toolDefinitions,
  ToolError,
  ToolRunError,
  truncate,
  type AgentAccess,
  type ProjectAccess,
  type SubagentAccess,
  type ReviewPlan,
  type RunSkill,
  type SkillFileAccess,
  type Tool,
  type ToolContext,
  type ToolOutput,
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
  /** True for a tool that always asks: Allow once and Deny only. */
  alwaysAsks?: boolean | undefined;
  /**
   * True when the agent's own setting for the tool is why it asks: Allow
   * once, Allow for this session and Deny only (agent tool approval design,
   * Q9).
   */
  agentSetting?: boolean | undefined;
  /** What the call is about, when the tool says (design, D27). */
  subject?: ApprovalSubject | undefined;
  /** The call's changes, when the tool describes them (plan P5). */
  review?: Review | undefined;
}

/**
 * What the run that asks offers while a request with a review is open: the
 * problems with a selection, whether the changes are out of date, and a
 * fresh review (undefined when the call can no longer be worked out).
 */
export interface ApprovalHooks {
  check: (selection: Selection) => string[];
  stale: () => boolean;
  refresh: () => Review | undefined;
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
  /**
   * Whether a call to this tool needs approval, for its subject when it has
   * one. Default: the tool's own.
   */
  needsApproval?: (tool: Tool, subject?: ApprovalSubject) => boolean;
  /**
   * Whether the agent's own setting for this tool decides that it asks.
   * Only asked for a tool that does not always ask. Default: no.
   */
  agentDecides?: (tool: Tool) => boolean;
  /**
   * Waits for the user's answer to an approval request, for as long as it
   * takes (6.5). When `signal` aborts, the loop stops waiting on its own;
   * the implementation should drop the request then. A decision comment is
   * kept only with "once" and "deny".
   */
  approve: (
    request: ApprovalRequest,
    signal: AbortSignal,
    hooks?: ApprovalHooks,
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
   * content), a tool result before `tool.result`, or the reminder the loop
   * adds to a subagent (agent delegation design, decision 36). For an assistant message,
   * `usage` is the model call's, as `message.finished` carries it; a tool
   * result has none.
   */
  onMessage?: (
    messageId: string,
    message: AssistantMessage | ToolResultMessage | UserMessage,
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
  /** The project's name, for forms tools show; null when there is none. */
  projectName?: string | null;
  /**
   * Project and global files. Left out: tools see session scope
   * only.
   */
  sharedFiles?: SharedFiles;
  /** What the model can read; left out when not known (attempts allowed). */
  mediaSupport?: MediaSupport;
  /** Stores bytes as blobs, for tools that make binary files. */
  blobs?: ToolContext["blobs"];
  /** The workspaces the session can use. Left out: none. */
  workspaces?: WorkspaceAccess;
  /** Searches files. Left out: the search tool fails. */
  searchFiles?: FileSearch;
  /**
   * Global, project and agent schemas and data. Left out: session scope
   * only.
   */
  sharedData?: SharedData;
  /**
   * Checks schemas and data against JSON Schema (Ajv, in the backend). Left
   * out: the schema and data tools fail.
   */
  schemaChecker?: SchemaChecker;
  /** Projects. Left out: the tools that use them fail. */
  projects?: ProjectAccess;
  /** The session's agents. Left out: the tools that use them fail. */
  agents?: AgentAccess;
  /** The most keys or ids one copy or move call may name. Default 20. */
  copyLimit?: number;
  /** The skills in scope for the run (skills design). Left out: none. */
  skills?: readonly RunSkill[];
  /** Reads those skills' files. Left out: none can be read. */
  skillFiles?: SkillFileAccess;
  /** Starting subagents. Left out: the tool that starts them fails. */
  subagents?: SubagentAccess;
  /**
   * Set for a subagent's run (agent delegation design). A response with no
   * tool calls does not end it: it gets `reminderText` as a user message, up
   * to `reminders` times (each counts as an iteration, decision 19), then
   * the last text is its output (decision 7). It ends when a tool hands back.
   */
  child?: { reminders: number; reminderText: string };
  /**
   * Takes the messages the user sent to this run while it ran, oldest first,
   * each as the text the model reads. The loop adds them as user messages
   * (source `user`) at the start of a step, and also when a subagent would
   * stop or hand back, so it gets one more step to read them. Left out:
   * none.
   */
  takeUserMessages?: () => string[];
  /**
   * All the session's messages, read when a tool runs, to rebuild the
   * session's files, schemas and data (decision 30). A run's request
   * can leave out other runs' messages; what they changed still counts.
   * Left out: the run's own transcript.
   */
  sessionMessages?: () => readonly Message[];
}

export const DEFAULT_COPY_LIMIT = 20;

const unavailable = (what: string) => (): never => {
  throw new ToolError(`${what} are not available in this run.`);
};

/** What a tool gets for projects when the run has none. */
export const NO_PROJECTS: ProjectAccess = {
  list: unavailable("Projects"),
  current: unavailable("Projects"),
  create: unavailable("Projects"),
  push: unavailable("Projects"),
};

/** What a tool gets for agents when the run has none. */
export const NO_AGENTS: AgentAccess = {
  list: unavailable("Agents"),
  startable: unavailable("Agents"),
  current: unavailable("Agents"),
};

/** What a tool gets for subagents when the run has none. */
export const NO_SUBAGENTS: SubagentAccess = {
  depth: 0,
  canStart: false,
  start: unavailable("Subagents"),
};

export type LoopEnd =
  "stop" | "iteration_limit" | "cancelled" | "failed" | "handed_back";

export interface LoopResult {
  reason: LoopEnd;
  usage?: Usage;
  /** Why the run failed, when `reason` is "failed". */
  error?: string;
  /**
   * For a subagent: what it handed back, or its last text when it ended
   * without handing back. Undefined for other runs.
   */
  output?: string;
}

export const DEFAULT_ERROR_LIMIT = 2000;
export const DEFAULT_PREVIEW_LIMIT = 500;

const CANCELLED = "Not run: the run was cancelled.";
const FAILED = "Not run: the run failed.";
const TRUNCATED =
  "Not run: the response was cut off at the token limit, so the arguments may be incomplete.";
const HANDED_BACK = "Not run: the subagent handed back.";

/** What ends a call's run: a failure, or a subagent's handback. */
interface CallEnd {
  failed?: string;
  handback?: string;
}

/** The text of an assistant message, joined. */
const textOf = (message: AssistantMessage): string =>
  message.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();

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
    ctx.needsApproval ?? ((tool: Tool) => tool.approval !== "never");
  const definitions = toolDefinitions(ctx.tools);
  const notRun = () => ctx.cancelledText?.() ?? CANCELLED;
  const transcript: Message[] = [...request.messages];
  let usage: Usage | undefined;
  // For a subagent: the reminders sent so far and its latest text.
  let remindersSent = 0;
  let lastText = "";

  const finish = (result: LoopResult): LoopResult => {
    // A subagent that ends without handing back still reports its last text.
    const withText =
      ctx.child && result.output === undefined && lastText !== ""
        ? { ...result, output: lastText }
        : result;
    const withUsage = { ...withText, ...(usage ? { usage } : {}) };
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
      files?: FileOp[];
      dataOps?: DataOp[];
      media?: MediaRef[];
      decisionComment?: ToolResultMessage["decisionComment"];
      prompt?: PromptRecord | undefined;
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
      ...(result.files?.length ? { files: result.files } : {}),
      ...(result.dataOps?.length ? { dataOps: result.dataOps } : {}),
      ...(result.media?.length ? { media: result.media } : {}),
      ...(result.decisionComment
        ? { decisionComment: result.decisionComment }
        : {}),
      ...(result.prompt ? { prompt: result.prompt } : {}),
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
    decisionComment?: ToolResultMessage["decisionComment"],
    prompt?: PromptRecord,
  ) => {
    const content = truncate(text, errorLimit);
    return addResult(call, {
      content,
      isError: true,
      ...(content !== text ? { error: text } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(decisionComment ? { decisionComment } : {}),
      ...(prompt ? { prompt } : {}),
    });
  };

  emit({
    type: "run.started",
    data: {
      kind: "loop",
      ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
      ...(ctx.parentCallId ? { parentCallId: ctx.parentCallId } : {}),
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
    addUserMessages();

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
      if (ctx.signal.aborted) return finish({ reason: "cancelled" });
      if (!ctx.child) return finish({ reason: "stop" });
      // A subagent ends by handing back. Remind it, then take its text.
      const text = textOf(step.message);
      if (text !== "") lastText = text;
      // A message is waiting: the next step reads it instead of a reminder.
      if (addUserMessages()) continue;
      if (remindersSent < ctx.child.reminders) {
        remindersSent++;
        const reminder: UserMessage = {
          role: "user",
          content: ctx.child.reminderText,
          source: "reminder",
        };
        ctx.onMessage?.(newId(), reminder);
        transcript.push(reminder);
        continue;
      }
      return finish({ reason: "stop", output: lastText });
    }
    if (ctx.child) {
      const text = textOf(step.message);
      if (text !== "") lastText = text;
    }

    let failed: string | undefined;
    let handback: string | undefined;
    for (const call of calls) {
      if (
        failed !== undefined ||
        handback !== undefined ||
        ctx.signal.aborted
      ) {
        addError(
          call,
          failed !== undefined
            ? FAILED
            : handback !== undefined
              ? HANDED_BACK
              : notRun(),
        );
        continue;
      }
      if (step.finishReason === "length") {
        addError(call, TRUNCATED);
        continue;
      }
      const end = await runCall(call, malformed.get(call.callId));
      failed = end?.failed;
      handback = end?.handback;
    }
    emit({ type: "step.finished", data: { index } });
    if (failed !== undefined)
      return finish({ reason: "failed", error: failed });
    // A message is waiting: the subagent reads it before it hands back, and
    // may hand back again.
    if (handback !== undefined && (ctx.signal.aborted || !addUserMessages()))
      return finish({ reason: "handed_back", output: handback });
    if (ctx.signal.aborted) return finish({ reason: "cancelled" });
  }

  /**
   * Adds the messages the user sent to this run as user messages and sends
   * their events. Returns whether there were any.
   */
  function addUserMessages(): boolean {
    const texts = ctx.takeUserMessages?.() ?? [];
    for (const content of texts) {
      const messageId = newId();
      const message: UserMessage = { role: "user", content, source: "user" };
      ctx.onMessage?.(messageId, message);
      transcript.push(message);
      emit({
        type: "user.message",
        data: { messageId, source: "user", content },
      });
    }
    return texts.length > 0;
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

  /**
   * Runs one call and adds its result. Returns an error to fail the run, or
   * a subagent's handback to end it.
   */
  async function runCall(
    call: ToolCall,
    malformedError: string | undefined,
  ): Promise<CallEnd | undefined> {
    /** Adds an error result and reports it. */
    const addReported = (
      kind: ToolErrorKind,
      text: string,
      extra: {
        durationMs?: number;
        decisionComment?: ToolResultMessage["decisionComment"];
        prompt?: PromptRecord | undefined;
        details?: Record<string, unknown> | undefined;
        stack?: string | undefined;
        endsRun?: boolean;
      } = {},
    ) => {
      const messageId = addError(
        call,
        text,
        extra.durationMs,
        extra.decisionComment,
        extra.prompt,
      );
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
    // The user's comment from the approval prompt, kept on the call's result.
    let decisionComment: ToolResultMessage["decisionComment"];
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

    /** The messages the session's files, schemas and data come from. */
    const sessionMessages = (): readonly Message[] =>
      ctx.sessionMessages?.() ?? transcript;
    /** The context a tool gets: for its review, then for its run. */
    const toolContext = (
      sessionOps: FileOp[],
      dataOps: DataOp[],
      requestInput: (form: Form) => Promise<InputAnswer>,
      approval?: ToolContext["approval"],
    ): ToolContext => ({
      signal: ctx.signal,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      callId: call.callId,
      ...(ctx.mediaSupport ? { mediaSupport: ctx.mediaSupport } : {}),
      ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
      ...(ctx.workspaces ? { workspaces: ctx.workspaces } : {}),
      update: (partial) =>
        emit({ type: "tool.update", data: { callId: call.callId, partial } }),
      state: latestToolState(transcript, tool.name),
      projectId: ctx.projectId ?? null,
      projectName: ctx.projectName ?? null,
      files: createFileAccess({
        session: replaySessionFiles(sessionMessages()),
        sessionOps,
        ...(ctx.sharedFiles ? { shared: ctx.sharedFiles } : {}),
        inProject: (ctx.projectId ?? null) !== null,
        author: { by: "model", sessionId: ctx.sessionId, runId: ctx.runId },
        ...(ctx.searchFiles
          ? {
              search: (q) =>
                (ctx.searchFiles as FileSearch)({
                  ...q,
                  signal: ctx.signal,
                }),
            }
          : {}),
      }),
      data: ctx.schemaChecker
        ? createDataAccess({
            session: replaySessionData(sessionMessages()),
            sessionOps: dataOps,
            ...(ctx.sharedData ? { shared: ctx.sharedData } : {}),
            checker: ctx.schemaChecker,
            projectId: ctx.projectId ?? null,
            agent: ctx.agent
              ? { id: ctx.agent.id, projectId: ctx.agent.projectId }
              : null,
            author: { by: "model", sessionId: ctx.sessionId, runId: ctx.runId },
          })
        : NO_DATA,
      projects: ctx.projects ?? NO_PROJECTS,
      agents: ctx.agents ?? NO_AGENTS,
      subagents: ctx.subagents ?? NO_SUBAGENTS,
      copyLimit: ctx.copyLimit ?? DEFAULT_COPY_LIMIT,
      skills: ctx.skills ?? [],
      skillFiles: ctx.skillFiles ?? NO_SKILL_FILES,
      requestInput,
      ...(approval ? { approval } : {}),
    });
    /** A review runs before anything is saved: its changes are dropped. */
    const reviewContext = () =>
      toolContext([], [], () =>
        Promise.reject(new Error("A tool cannot ask while it is reviewed.")),
      );
    let approval: ToolContext["approval"];

    let subject: ApprovalSubject | undefined;
    try {
      subject = tool.approvalSubject?.(parsed.input, reviewContext());
    } catch {
      // A call that cannot name its subject asks like any other.
      subject = undefined;
    }
    if (needsApproval(tool, subject)) {
      const requestId = newId();
      // The call's changes, for the prompt (plan P5).
      let plan: ReviewPlan | undefined;
      if (tool.review) {
        let reviewed: ReviewPlan | ToolOutput;
        try {
          reviewed = tool.review(parsed.input, reviewContext());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          addReported("tool_threw", `${tool.name} failed: ${message}`, {
            details: err instanceof ToolError ? err.details : undefined,
            stack: err instanceof Error ? err.stack : undefined,
          });
          return;
        }
        if (!("review" in reviewed)) {
          const text = serializeResult(reviewed.data);
          const content = reviewed.isError ? truncate(text, errorLimit) : text;
          const messageId = addResult(call, {
            content,
            isError: reviewed.isError ?? false,
            data: reviewed.data,
            ...(content !== text ? { error: text } : {}),
          });
          if (reviewed.isError) {
            report("tool_returned_error", messageId, text, {
              details: reviewed.details,
            });
          }
          return;
        }
        plan = reviewed;
      }
      const hooks: ApprovalHooks | undefined = plan
        ? {
            check: (selection) => (plan as ReviewPlan).check(selection),
            stale: () => (plan as ReviewPlan).stale(),
            refresh: () => {
              const next = tool.review?.(parsed.input, reviewContext());
              if (!next || !("review" in next)) return undefined;
              plan = next;
              return next.review;
            },
          }
        : undefined;
      const alwaysAsks = tool.approval === "always";
      const agentSetting = !alwaysAsks && ctx.agentDecides?.(tool) === true;
      emit({
        type: "tool.approval_requested",
        data: {
          requestId,
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          ...(alwaysAsks ? { alwaysAsks } : {}),
          ...(agentSetting ? { agentSetting } : {}),
          ...(subject ? { subject } : {}),
          ...(plan ? { review: plan.review } : {}),
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
              ...(alwaysAsks ? { alwaysAsks } : {}),
              ...(agentSetting ? { agentSetting } : {}),
              ...(subject ? { subject } : {}),
              ...(plan ? { review: plan.review } : {}),
            },
            ctx.signal,
            hooks,
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
        choice === "once" || choice === "deny"
          ? answer.decisionComment?.trim()
          : "";
      emit({
        type: "tool.approval_resolved",
        data: {
          requestId,
          choice,
          ...(text ? { decisionComment: text } : {}),
        },
      });
      if (text) {
        decisionComment = {
          text,
          choice: choice === "deny" ? "deny" : "once",
        };
      }
      if (choice === "deny") {
        addError(
          call,
          "The user denied this tool call.",
          undefined,
          decisionComment,
        );
        return;
      }
      if (plan) {
        approval = {
          review: plan.review,
          selection: choice === "once" ? answer.selection : undefined,
        };
      }
    }

    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const sessionOps: FileOp[] = [];
    const dataOps: DataOp[] = [];
    // The form a tool showed (at most one per call, tool prompts D10) and
    // whether the user skipped it.
    let asked = false;
    let prompt: PromptRecord | undefined;
    let skipped = false;
    const ask = async (form: Form): Promise<InputAnswer> => {
      if (asked) throw new Error("A tool can ask the user only once per call.");
      asked = true;
      const answer = await requestInput(call, form);
      if (tool.name !== ASK_USER) prompt = describePrompt(form, answer);
      skipped = answer.outcome === "skipped";
      return answer;
    };
    try {
      const output = await tool.execute(
        parsed.input,
        toolContext(sessionOps, dataOps, ask, approval),
      );
      const text = serializeResult(output.data);
      const content = output.isError ? truncate(text, errorLimit) : text;
      const messageId = addResult(call, {
        content,
        isError: output.isError ?? false,
        data: output.data,
        ...(output.state !== undefined ? { state: output.state } : {}),
        // Session-scoped changes count only when the tool succeeded.
        ...(output.isError ? {} : { files: sessionOps, dataOps }),
        ...(!output.isError && output.media?.length
          ? { media: output.media }
          : {}),
        ...(content !== text ? { error: text } : {}),
        ...(decisionComment ? { decisionComment } : {}),
        prompt,
        durationMs: elapsed(),
      });
      // A declined or skipped form is the user's choice, not an error (O1);
      // so is a tool's error result after its form was skipped (tool
      // prompts D5).
      const declined =
        skipped || (tool.name === ASK_USER && output.data === DECLINED);
      if (output.isError && !declined) {
        report("tool_returned_error", messageId, text, {
          details: output.details,
        });
      }
      if (output.handback !== undefined && !output.isError) {
        return { handback: output.handback };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const thrown = {
        durationMs: elapsed(),
        decisionComment,
        prompt,
        details: err instanceof ToolError ? err.details : undefined,
        stack: err instanceof Error ? err.stack : undefined,
      };
      if (err instanceof ToolRunError) {
        addReported("tool_threw", message, { ...thrown, endsRun: true });
        return { failed: message };
      }
      if (ctx.signal.aborted) {
        addError(call, notRun(), elapsed(), decisionComment, prompt);
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
