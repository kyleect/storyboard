import {
  buildMessageContent,
  editNotice,
  RunControl,
  runLoop,
  type EntryOp,
  type EntrySearch,
  type ApprovalAnswer,
  type ApprovalRequest,
  type AssistantMessage,
  type ChatRequest,
  type ContentBlock,
  type ControlResult,
  type HarnessEvent,
  type Message,
  type RunAgent,
  type ModelAdapter,
  type StoredEvent,
  type Tool,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import type { Agent, AgentStore } from "./agents-store.js";
import type { Settings } from "./settings.js";
import type { EntryStore } from "./entries-store.js";
import type { SearchIndex } from "./search-index.js";
import {
  NO_GENERATION,
  type Generation,
  type SessionRow,
  type Store,
} from "./store.js";
import { setToolAsks, toolAsks } from "./tool-settings.js";

/** Choices sent with a message or continue; they become the session's. */
export interface RunChoices {
  model?: string;
  reasoningEffort?: string;
  /** Null: no agent (agents design, decisions 11, 12). */
  agentId?: string | null;
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
  resolve: (answer: ApprovalAnswer) => void;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  generation: Generation;
  agent: RunAgent | null;
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
    /** The agent version the run uses; null: none. */
    agent: RunAgent | null;
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
  /**
   * Every tool. A session with no agent gets all of them (tools design
   * 6.11); an agent narrows them (agents design 6).
   */
  tools?: readonly Tool[];
  /**
   * Names of the tools every agent gets, whatever its selection (the files
   * and memory tools, agents design 8).
   */
  alwaysOnTools?: readonly string[];
  /** Agents. Left out: sessions cannot pick one. */
  agents?: AgentStore;
  /**
   * Project and global files and notes for tools. Left out: tools see
   * session scope only.
   */
  entries?: EntryStore;
  /**
   * A system message put before the transcript of every model call; not
   * stored. Undefined: none. An agent's prompt goes before it, in the same
   * message (agents design 9).
   */
  systemPrompt?: (session: SessionRow) => string | undefined;
  /** Generates memory note ids. Default: 8 random hex digits. */
  newNoteId?: () => string;
  /** Kept in step with session-scoped changes, when given. */
  index?: SearchIndex;
  /** The search tools' backend for a session. Left out: search fails. */
  search?: (session: SessionRow) => EntrySearch;
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
  /** Tools every agent gets (agents design 8). */
  readonly alwaysOnTools: readonly string[];

  constructor(private readonly options: RunManagerOptions) {
    this.store = options.store;
    this.tools = options.tools ?? [];
    this.alwaysOnTools = options.alwaysOnTools ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Moves a session to the trash and emits `session.trashed` (design Q3,
   * Q7). Refused while a run is in progress in it (Q5).
   */
  trashSession(sessionId: string) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RunError("Session not found.", 404);
    if (session.trashed_at !== null) {
      throw new RunError("The session is already in the trash.", 409);
    }
    if (this.hasActiveRun(sessionId)) {
      throw new RunError(
        "A run is in progress in this session. Wait for it to end or cancel it.",
        409,
      );
    }
    const now = this.now();
    this.store.setSessionTrashed(sessionId, now);
    this.publish({
      runId: null,
      sessionId,
      time: now,
      type: "session.trashed",
      data: {},
    });
  }

  /**
   * Moves a project and its sessions to the trash, emitting
   * `session.trashed` for each session moved (design Q12). Refused while a
   * run is in progress in any of its sessions (Q12a).
   */
  trashProject(projectId: string) {
    const project = this.store.getProject(projectId);
    if (!project) throw new RunError("Project not found.", 404);
    if (project.trashed_at !== null) {
      throw new RunError("The project is already in the trash.", 409);
    }
    for (const run of this.active.values()) {
      if (this.store.getSession(run.sessionId)?.project_id === projectId) {
        throw new RunError(
          "A run is in progress in one of this project's sessions. Wait for it to end or cancel it.",
          409,
        );
      }
    }
    const now = this.now();
    for (const sessionId of this.store.trashProject(projectId, now)) {
      this.publish({
        runId: null,
        sessionId,
        time: now,
        type: "session.trashed",
        data: {},
      });
    }
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
    this.checkAgentChoice(sessionId, choices);
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
      this.checkAgentChoice(sessionId, choices);
      this.store.setSessionChoices(sessionId, choices);
      return this.start(sessionId, {
        messageId: last.id,
        message: last.message,
      });
    }
    if (last?.message.role === "tool") {
      this.checkAgentChoice(sessionId, choices);
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
   * the tool runs. A note goes with "once" or "deny" only.
   */
  answerApproval(runId: string, requestId: string, answer: ApprovalAnswer) {
    const { choice } = answer;
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
    open.resolve(answer);
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
        agent: run.agent,
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
      const generation: Generation = {
        model: run.model,
        reasoningEffort: run.reasoning_effort,
        agent:
          run.agent_id !== null && run.agent_version !== null
            ? { id: run.agent_id, version: run.agent_version }
            : null,
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
          lastStreamedUsage(events, partial.messageId),
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

  /**
   * Records the user's changes to session-scoped files or notes as an edit
   * message and emits `session.entries_changed` (files and memory design,
   * decision 11). Refused while a run is in progress (plan P5).
   */
  editSessionEntries(sessionId: string, ops: EntryOp[]): { messageId: string } {
    this.requireIdle(sessionId);
    const messageId = this.newId();
    this.store.addMessage(
      sessionId,
      messageId,
      { role: "edit", content: editNotice(ops), entries: ops },
      this.now(),
    );
    this.indexSessionOps(sessionId, ops);
    this.publish({
      runId: null,
      sessionId,
      time: this.now(),
      type: "session.entries_changed",
      data: { messageId },
    });
    return { messageId };
  }

  /** Keeps the search index in step with session-scoped changes. */
  private indexSessionOps(sessionId: string, ops: readonly EntryOp[]) {
    for (const op of ops) {
      this.options.index?.indexEntry(
        op.kind,
        "session",
        sessionId,
        op.key,
        op.op === "put" ? op.value : null,
      );
    }
  }

  /**
   * Refuses an agent the session cannot use: 404 when there is no such
   * agent, 409 when it is deleted or belongs to another project (agents
   * design 16). Null (no agent) and a field left out are always allowed.
   */
  checkAgentChoice(sessionId: string, choices: { agentId?: string | null }) {
    if (choices.agentId === undefined || choices.agentId === null) return;
    const agents = this.options.agents;
    const agent = agents?.get(choices.agentId);
    if (!agents || !agent) throw new RunError("Agent not found.", 404);
    const session = this.store.getSession(sessionId);
    if (!session) throw new RunError("Session not found.", 404);
    if (agent.deleted) throw new RunError("The agent is deleted.", 409);
    if (!agents.usableIn(agent, session.project_id)) {
      throw new RunError("This session cannot use that agent.", 409);
    }
  }

  /** The tools a run gets with this agent (agents design 6, 8, 35). */
  private toolsFor(agent: Agent | null): readonly Tool[] {
    if (!agent) return this.tools;
    const alwaysOn = new Set(this.alwaysOnTools);
    const listed = new Set(agent.tools);
    return this.tools.filter(
      (t) =>
        alwaysOn.has(t.name) ||
        (agent.toolMode === "allow" ? listed.has(t.name) : !listed.has(t.name)),
    );
  }

  private requireIdle(sessionId: string) {
    if (this.shuttingDown)
      throw new RunError("The backend is shutting down.", 503);
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new RunError("Session not found.", 404);
    }
    if (session.trashed_at !== null) {
      throw new RunError("The session is in the trash.", 409);
    }
    if (this.hasActiveRun(sessionId)) {
      throw new RunError("A run is already in progress in this session.", 409);
    }
  }

  /** Sending or continuing counts as using the project (design Q15a). */
  private touchProject(sessionId: string) {
    const projectId = this.store.getSession(sessionId)?.project_id;
    if (projectId) this.store.touchProject(projectId, this.now());
  }

  private hasActiveRun(sessionId: string): boolean {
    for (const run of this.active.values()) {
      if (run.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Stores an event, then sends it to the session's listeners. */
  private publish(event: HarnessEvent) {
    const stored = this.store.insertEvent(event);
    for (const l of this.listeners.get(event.sessionId) ?? []) l(stored);
  }

  private start(
    sessionId: string,
    continuing: { messageId: string; message: AssistantMessage } | null,
  ): { runId: string } {
    this.touchProject(sessionId);
    const settings = this.options.settings();
    const runId = this.newId();
    // The session's choices, else the default settings. Empty: not sent.
    const session = this.store.getSession(sessionId);
    // The session's agent as it is now; the run keeps this version to the
    // end (agents design 13, 24). One it can no longer use counts as none.
    const picked =
      session?.agent_id != null
        ? this.options.agents?.get(session.agent_id)
        : undefined;
    const agent =
      picked &&
      session &&
      this.options.agents?.usableIn(picked, session.project_id)
        ? picked
        : null;
    const runAgent: RunAgent | null = agent
      ? {
          id: agent.id,
          name: agent.name,
          version: agent.version,
          projectId: agent.projectId,
        }
      : null;
    const generation: Generation = {
      model: session?.model || settings.model || null,
      reasoningEffort:
        session?.reasoning_effort || settings.reasoningEffort || null,
      agent: agent ? { id: agent.id, version: agent.version } : null,
    };
    const control = new RunControl();
    const base = session ? this.options.systemPrompt?.(session) : undefined;
    // The agent's prompt, then the files and memory instruction (design 9).
    const system =
      [agent?.prompt, base]
        .filter((p): p is string => p !== undefined && p !== "")
        .join("\n\n") || undefined;
    const request: ChatRequest = {
      kind: "chat",
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        ...this.store.listMessages(sessionId).map((m) => m.message),
      ],
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
      this.publish(e);
    };

    const saveMessage = (id: string, message: Message, usage?: Usage) => {
      this.store.saveMessage(
        sessionId,
        id,
        message,
        this.now(),
        message.role === "assistant" ? generation : NO_GENERATION,
        usage ?? null,
      );
      this.store.linkRunMessage(runId, id);
      if (message.role === "tool" && message.entries) {
        this.indexSessionOps(sessionId, message.entries);
      }
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
          tools: this.toolsFor(agent),
          ...(runAgent ? { agent: runAgent } : {}),
          projectId: session?.project_id ?? null,
          ...(this.options.entries
            ? {
                sharedEntries: this.options.entries.shared(
                  session?.project_id ?? null,
                ),
              }
            : {}),
          ...(this.options.newNoteId
            ? { newNoteId: this.options.newNoteId }
            : {}),
          ...(this.options.search && session
            ? { searchEntries: this.options.search(session) }
            : {}),
          maxIterations: settings.loopLimit,
          needsApproval: (tool) =>
            toolAsks(this.store.db, tool) &&
            !this.store.isToolAllowedForSession(sessionId, tool.name),
          approve: (req, signal) =>
            new Promise<ApprovalAnswer>((resolve) => {
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
      agent: runAgent,
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

/**
 * The latest running usage streamed for a message (its last delta that
 * carried one), for a message the backend stopped writing; null when none
 * did.
 */
function lastStreamedUsage(
  events: readonly StoredEvent[],
  messageId: string,
): Usage | null {
  let usage: Usage | null = null;
  for (const e of events) {
    if (
      (e.type === "text.delta" || e.type === "reasoning.delta") &&
      e.data.messageId === messageId &&
      e.data.usage
    ) {
      usage = e.data.usage;
    }
  }
  return usage;
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
