import {
  buildMessageContent,
  RunControl,
  runSingleCall,
  type ControlResult,
  type AssistantMessage,
  type ChatRequest,
  type ContentBlock,
  type HarnessEvent,
  type ModelAdapter,
  type StoredEvent,
} from "@harness/core";
import type { Settings } from "./settings.js";
import type { Generation, Store } from "./store.js";

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

interface ActiveRun {
  runId: string;
  sessionId: string;
  messageId: string;
  generation: Generation;
  /** The stored content the run started from (when continuing). */
  initial: readonly ContentBlock[];
  controller: AbortController;
  control: RunControl;
  done: Promise<void>;
}

export interface Snapshot {
  lastEventId: number;
  activeRun: {
    runId: string;
    messageId: string;
    model: string | null;
    reasoningEffort: string | null;
    continuing: boolean;
    content: ContentBlock[];
  } | null;
}

export interface RunManagerOptions {
  store: Store;
  settings: () => Settings;
  model: (settings: Settings) => ModelAdapter;
  now?: () => string;
  newId?: () => string;
}

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

  constructor(private readonly options: RunManagerOptions) {
    this.store = options.store;
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
   * Continues the last assistant message (assistant prefill). The choices
   * become the session's before the run starts.
   */
  continueLast(sessionId: string, choices: RunChoices = {}): { runId: string } {
    this.requireIdle(sessionId);
    const last = this.store.listMessages(sessionId).at(-1);
    if (!last || last.message.role !== "assistant") {
      throw new RunError("The last message is not an assistant message.", 409);
    }
    this.store.setSessionChoices(sessionId, choices);
    return this.start(sessionId, { messageId: last.id, message: last.message });
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
        messageId: run.messageId,
        model: run.generation.model,
        reasoningEffort: run.generation.reasoningEffort,
        continuing: run.initial.length > 0,
        content: buildMessageContent(
          this.store.runEvents(run.runId),
          run.messageId,
          run.initial,
        ),
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
   * After a crash: runs still marked running are ended as interrupted, and
   * their partial text is saved from the stored events.
   */
  recover(): string[] {
    const recovered: string[] = [];
    for (const run of this.store.runningRuns()) {
      const existing = this.store.getMessage(run.message_id);
      const initial = existing?.role === "assistant" ? existing.content : [];
      const content = buildMessageContent(
        this.store.runEvents(run.id),
        run.message_id,
        initial,
      );
      if (content.length > 0) {
        this.store.saveMessage(
          run.session_id,
          run.message_id,
          { role: "assistant", content },
          this.now(),
          { model: run.model, reasoningEffort: run.reasoning_effort },
        );
      }
      this.store.insertEvent({
        runId: run.id,
        sessionId: run.session_id,
        time: this.now(),
        type: "run.interrupted",
        data: {},
      });
      this.store.endRun(run.id, "interrupted", this.now());
      recovered.push(run.id);
    }
    return recovered;
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
    const messageId = continuing?.messageId ?? this.newId();
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
      kind: "single",
      messageId,
      now: this.now(),
      generation,
    });

    const controller = new AbortController();
    let failure: string | undefined;
    const emit = (event: HarnessEvent) => {
      if (event.type === "run.failed") failure = event.data.error;
      // Runs stopped by shutdown end as interrupted, not cancelled.
      const e: HarnessEvent =
        this.shuttingDown && event.type === "run.finished"
          ? { ...event, type: "run.interrupted", data: {} }
          : event;
      const stored = this.store.insertEvent(e);
      for (const l of this.listeners.get(sessionId) ?? []) l(stored);
    };

    const execute = async () => {
      try {
        const result = await runSingleCall(
          this.options.model(settings),
          request,
          {
            runId,
            sessionId,
            emit,
            signal: controller.signal,
            newId: this.newId,
            now: this.now,
            ...(continuing ? { continueMessage: continuing } : { messageId }),
          },
        );
        if (result.message.content.length > 0) {
          this.store.saveMessage(
            sessionId,
            messageId,
            result.message,
            this.now(),
            generation,
          );
        }
        const status =
          result.finishReason === "error"
            ? "failed"
            : this.shuttingDown
              ? "interrupted"
              : result.finishReason === "cancelled"
                ? "cancelled"
                : "finished";
        this.store.endRun(runId, status, this.now(), result.usage, failure);
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
      messageId,
      generation,
      initial: continuing?.message.content ?? [],
      controller,
      control,
      done: Promise.resolve(),
    };
    this.active.set(runId, run);
    run.done = execute();
    return { runId };
  }
}
