import {
  buildMessageContent,
  RunControl,
  runLoop,
  type ApprovalChoice,
  type ApprovalRequest,
  type AssistantMessage,
  type ChatRequest,
  type ContentBlock,
  type ControlResult,
  type HarnessEvent,
  type Message,
  type ModelAdapter,
  type StoredEvent,
  type Tool,
  type ToolResultMessage,
} from "@harness/core";
import type { Settings } from "./settings.js";
import type { Generation, Store } from "./store.js";
import { setToolAsks, toolAsks } from "./tool-settings.js";

/** Choices sent with a message or continue; they become the session's. */
export interface RunChoices {
  model?: string;
  reasoningEffort?: string;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RunError";
  }
}

type Listener = (event: StoredEvent) => void;

interface OpenApproval {
  request: ApprovalRequest;
  resolve: (choice: ApprovalChoice) => void;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  generation: Generation;
  controller: AbortController;
  control: RunControl;
  /** Approval requests waiting for an answer, by request id. */
  approvals: Map<string, OpenApproval>;
  done: Promise<void>;
}

export interface Snapshot {
  lastEventId: number;
  activeRun: {
    runId: string;
    model: string | null;
    reasoningEffort: string | null;
    /** The message being written now; null while a tool runs. */
    message: {
      messageId: string;
      continuing: boolean;
      content: ContentBlock[];
    } | null;
    /** Approval requests waiting for an answer (design D13, item 5). */
    approvals: ApprovalRequest[];
  } | null;
}

export interface RunManagerOptions {
  store: Store;
  settings: () => Settings;
  model: (settings: Settings) => ModelAdapter;
  /** Every session gets every tool (tools design 6.11). */
  tools?: readonly Tool[];
  now?: () => string;
  newId?: () => string;
}

const INTERRUPTED_CALL =
  "Interrupted: the backend stopped before this call finished.";
const STOPPED_CALL = "Not run: the backend was stopped.";

/**
 * Starts, cancels and records runs. Every event is stored before it is sent
 * to listeners, so a reconnecting client can replay from its last event id.
 */
export class RunManager {
  private readonly store: Store;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly active = new Map<string, ActiveRun>();
  private shuttingDown = false;
  private readonly now: () => string;
  private readonly newId: () => string;
  readonly tools: readonly Tool[];

  constructor(private readonly options: RunManagerOptions) {
    this.store = options.store;
    this.tools = options.tools ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Listen to a session's events. Returns the unsubscribe function. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  /**
   * Adds a user message and starts a run that answers it. The choices become
   * the session's before the run starts.
   */
  sendMessage(
    sessionId: string,
    content: string,
    choices: RunChoices = {},
  ): { runId: string } {
    this.requireIdle(sessionId);
    this.store.setSessionChoices(sessionId, choices);
    this.store.addMessage(
      sessionId,
      this.newId(),
      { role: "user", content },
      this.now(),
    );
    return this.start(sessionId, null);
  }

  /**
   * Continues the session. After an assistant message, continues that
   * message (assistant prefill). After a tool result (a run that stopped
   * between steps), starts the next step. The choices become the session's
   * before the run starts.
   */
  continueLast(sessionId: string, choices: RunChoices = {}): { runId: string } {
    this.requireIdle(sessionId);
    const last = this.store.listMessages(sessionId).at(-1);
    if (last?.message.role === "assistant") {
      if (last.message.content.some((b) => b.type === "tool_call")) {
        throw new RunError(
          "A message that contains tool calls cannot be continued.",
          409,
        );
      }
      this.store.setSessionChoices(sessionId, choices);
      return this.start(sessionId, {
        messageId: last.id,
        message: last.message,
      });
    }
    if (last?.message.role === "tool") {
      this.store.setSessionChoices(sessionId, choices);
      return this.start(sessionId, null);
    }
    throw new RunError(
      "The last message is not an assistant message or a tool result.",
      409,
    );
  }

  /** Asks the model to stop reasoning and answer. */
  async endReasoning(runId: string): Promise<ControlResult> {
    const run = this.active.get(runId);
    if (!run) return { ok: false, message: "The run is not active." };
    return run.control.endReasoning();
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Answers an approval request. "session" and "always" are recorded before
   * the tool runs.
   */
  answerApproval(runId: string, requestId: string, choice: ApprovalChoice) {
    const run = this.active.get(runId);
    if (!run) throw new RunError("The run is not active.", 409);
    const open = run.approvals.get(requestId);
    if (!open) {
      throw new RunError("No open approval request with that id.", 404);
    }
    const tool = this.tools.find((t) => t.name === open.request.name);
    if (choice === "session") {
      this.store.allowToolForSession(
        run.sessionId,
        open.request.name,
        this.now(),
      );
    } else if (choice === "always" && tool) {
      setToolAsks(this.store.db, tool, false);
    }
    run.approvals.delete(requestId);
    open.resolve(choice);
  }

  snapshot(sessionId: string): Snapshot {
    const lastEventId = this.store.lastEventId(sessionId);
    const run = [...this.active.values()].find(
      (r) => r.sessionId === sessionId,
    );
    if (!run) return { lastEventId, activeRun: null };
    return {
      lastEventId,
      activeRun: {
        runId: run.runId,
        model: run.generation.model,
        reasoningEffort: run.generation.reasoningEffort,
        message: this.inFlight(this.store.runEvents(run.runId)),
        approvals: [...run.approvals.values()].map((a) => a.request),
      },
    };
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  /** Stops all runs; they end as interrupted. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((r) => r.done));
  }

  /**
   * After a crash: runs still marked running are ended as interrupted. The
   * partial message is saved from the stored events, and every tool call the
   * run made without a result gets an error result saying it was
   * interrupted; the tool is not run again (tools design 6.10). Open
   * approval requests are withdrawn.
   */
  recover(): string[] {
    const recovered: string[] = [];
    for (const run of this.store.runningRuns()) {
      const events = this.store.runEvents(run.id);
      const generation = {
        model: run.model,
        reasoningEffort: run.reasoning_effort,
      };
      const base = { runId: run.id, sessionId: run.session_id };
      const insert = (event: HarnessEvent) => this.store.insertEvent(event);

      const partial = this.inFlight(events);
      if (partial && partial.content.length > 0) {
        this.store.saveMessage(
          run.session_id,
          partial.messageId,
          { role: "assistant", content: partial.content },
          this.now(),
          generation,
        );
        this.store.linkRunMessage(run.id, partial.messageId);
      }

      for (const e of openApprovals(events)) {
        insert({
          ...base,
          time: this.now(),
          type: "request.cancel",
          data: { requestId: e, reason: "The backend stopped." },
        });
      }

      const answered = new Set(
        this.store
          .listMessages(run.session_id)
          .flatMap((m) =>
            m.message.role === "tool" ? [m.message.callId] : [],
          ),
      );
      for (const messageId of this.store.runMessageIds(run.id)) {
        const message = this.store.getMessage(messageId);
        if (message?.role !== "assistant") continue;
        for (const block of message.content) {
          if (block.type !== "tool_call" || answered.has(block.callId))
            continue;
          const id = this.newId();
          const result: ToolResultMessage = {
            role: "tool",
            callId: block.callId,
            name: block.name,
            content: INTERRUPTED_CALL,
            isError: true,
          };
          this.store.addMessage(run.session_id, id, result, this.now());
          this.store.linkRunMessage(run.id, id);
          insert({
            ...base,
            time: this.now(),
            type: "tool.result",
            data: {
              messageId: id,
              callId: block.callId,
              name: block.name,
              isError: true,
              preview: INTERRUPTED_CALL,
              durationMs: 0,
            },
          });
        }
      }

      insert({ ...base, time: this.now(), type: "run.interrupted", data: {} });
      this.store.endRun(run.id, "interrupted", this.now());
      recovered.push(run.id);
    }
    return recovered;
  }

  /** The message a run is writing, rebuilt from its events. */
  private inFlight(
    events: readonly StoredEvent[],
  ): NonNullable<Snapshot["activeRun"]>["message"] {
    let started: Extract<StoredEvent, { type: "message.started" }> | undefined;
    for (const e of events) {
      if (e.type === "message.started") started = e;
      else if (
        e.type === "message.finished" &&
        e.data.messageId === started?.data.messageId
      ) {
        started = undefined;
      }
    }
    if (!started) return null;
    const { messageId } = started.data;
    const continuing = started.data.continuing ?? false;
    // Until it finishes, a continued message is stored as it was before.
    const stored = continuing ? this.store.getMessage(messageId) : undefined;
    const initial = stored?.role === "assistant" ? stored.content : [];
    return {
      messageId,
      continuing,
      content: buildMessageContent(events, messageId, initial),
    };
  }

  private requireIdle(sessionId: string) {
    if (this.shuttingDown)
      throw new RunError("The backend is shutting down.", 503);
    if (!this.store.getSession(sessionId)) {
      throw new RunError("Session not found.", 404);
    }
    for (const run of this.active.values()) {
      if (run.sessionId === sessionId) {
        throw new RunError(
          "A run is already in progress in this session.",
          409,
        );
      }
    }
  }

  private start(
    sessionId: string,
    continuing: { messageId: string; message: AssistantMessage } | null,
  ): { runId: string } {
    const settings = this.options.settings();
    const runId = this.newId();
    // The session's choices, else the default settings. Empty: not sent.
    const session = this.store.getSession(sessionId);
    const generation: Generation = {
      model: session?.model || settings.model || null,
      reasoningEffort:
        session?.reasoning_effort || settings.reasoningEffort || null,
    };
    const control = new RunControl();
    const request: ChatRequest = {
      kind: "chat",
      messages: this.store.listMessages(sessionId).map((m) => m.message),
      control,
      ...(generation.model ? { model: generation.model } : {}),
      ...(generation.reasoningEffort
        ? { reasoningEffort: generation.reasoningEffort }
        : {}),
    };
    this.store.createRun({
      id: runId,
      sessionId,
      kind: "loop",
      now: this.now(),
      generation,
    });

    const controller = new AbortController();
    const approvals = new Map<string, OpenApproval>();
    const emit = (event: HarnessEvent) => {
      // Runs stopped by shutdown end as interrupted, not cancelled.
      const e: HarnessEvent =
        this.shuttingDown && event.type === "run.finished"
          ? { ...event, type: "run.interrupted", data: {} }
          : event;
      const stored = this.store.insertEvent(e);
      for (const l of this.listeners.get(sessionId) ?? []) l(stored);
    };

    const saveMessage = (id: string, message: Message) => {
      this.store.saveMessage(
        sessionId,
        id,
        message,
        this.now(),
        message.role === "assistant"
          ? generation
          : { model: null, reasoningEffort: null },
      );
      this.store.linkRunMessage(runId, id);
    };

    const execute = async () => {
      try {
        const result = await runLoop(this.options.model(settings), request, {
          runId,
          sessionId,
          emit,
          signal: controller.signal,
          newId: this.newId,
          now: this.now,
          ...(continuing ? { continueMessage: continuing } : {}),
          tools: this.tools,
          maxIterations: settings.loopLimit,
          needsApproval: (tool) =>
            toolAsks(this.store.db, tool) &&
            !this.store.isToolAllowedForSession(sessionId, tool.name),
          approve: (req, signal) =>
            new Promise<ApprovalChoice>((resolve) => {
              approvals.set(req.requestId, { request: req, resolve });
              signal.addEventListener(
                "abort",
                () => approvals.delete(req.requestId),
                { once: true },
              );
            }),
          onMessage: saveMessage,
          cancelledText: () => (this.shuttingDown ? STOPPED_CALL : undefined),
        });
        const status =
          result.reason === "failed"
            ? "failed"
            : this.shuttingDown
              ? "interrupted"
              : result.reason === "cancelled"
                ? "cancelled"
                : "finished";
        this.store.endRun(
          runId,
          status,
          this.now(),
          result.usage,
          result.error,
        );
      } catch (err) {
        // Unexpected (for example a database error). Record what we can.
        const message = err instanceof Error ? err.message : String(err);
        try {
          emit({
            runId,
            sessionId,
            time: this.now(),
            type: "run.failed",
            data: { error: message },
          });
          this.store.endRun(runId, "failed", this.now(), undefined, message);
        } catch {
          // The database itself failed; recover() will handle it next start.
        }
      } finally {
        this.active.delete(runId);
      }
    };

    const run: ActiveRun = {
      runId,
      sessionId,
      generation,
      controller,
      control,
      approvals,
      done: Promise.resolve(),
    };
    this.active.set(runId, run);
    run.done = execute();
    return { runId };
  }
}

/** Request ids of approval requests with no answer or withdrawal. */
function openApprovals(events: readonly StoredEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type === "tool.approval_requested") open.add(e.data.requestId);
    else if (e.type === "tool.approval_resolved" || e.type === "request.cancel")
      open.delete(e.data.requestId);
  }
  return [...open];
}
