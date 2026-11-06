import {
  buildMessageContent,
  editNotice,
  RunControl,
  runLoop,
  type EntryOp,
  type EntrySearch,
  type ApprovalAnswer,
  type ApprovalHooks,
  type ApprovalRequest,
  selectAll,
  type Selection,
  checkAnswers,
  type InputAnswer,
  type InputRequest,
  type AssistantMessage,
  type ChatRequest,
  type ContentBlock,
  type ControlResult,
  type HarnessEvent,
  type Message,
  type RunAgent,
  type RunSkill,
  type ModelAdapter,
  type StoredEvent,
  type RunFacts,
  type Tool,
  type ToolResultMessage,
  type UserMessage,
  type LoopResult,
  type SubagentOutcome,
  type Usage,
  dataEditNotice,
  replaySessionData,
  type DataOp,
  type SchemaChecker,
  type SchemaScope,
  toolDefinitions,
} from "@harness/core";
import type { Agent, AgentStore } from "./agents-store.js";
import type { DataStore } from "./data-store.js";
import type { SkillStore } from "./skills-store.js";
import { AppEvents } from "./app-events.js";
import { ErrorStore, type NewError } from "./errors-store.js";
import { cleanTitle, requestTitle } from "./auto-title.js";
import type { Settings } from "./settings.js";
import type { EntryStore } from "./entries-store.js";
import type { SearchIndex } from "./search-index.js";
import {
  DEFAULT_TITLE,
  NO_GENERATION,
  type Generation,
  type SessionRow,
  type Store,
} from "./store.js";
import {
  alwaysAsks,
  alwaysOnNames,
  offNames,
  setToolAsks,
  toolApproval,
} from "./tool-settings.js";
import { allowedNames } from "./tool-grants.js";
import { agentAccess, projectAccess } from "./tool-access.js";
import {
  expandPlaceholders,
  toolsList,
  usesPlaceholder,
} from "./placeholders.js";

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
  /** For a request with a review (plan P5). */
  hooks?: ApprovalHooks | undefined;
}

interface OpenInput {
  request: InputRequest;
  resolve: (answer: InputAnswer) => void;
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
  /** Forms waiting for an answer, by request id (input forms design). */
  inputs: Map<string, OpenInput>;
  /** For a subagent's run: the run and call that started it. */
  parent: { runId: string; callId: string } | null;
  done: Promise<void>;
}

/** One active run as a reconnecting client sees it. */
export interface RunSnapshot {
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
  /** Forms waiting for an answer (input forms design, D13). */
  inputs: InputRequest[];
}

export interface Snapshot {
  lastEventId: number;
  /** The session's top-level run. */
  activeRun: RunSnapshot | null;
  /**
   * The subagent runs in progress, each with the run and call that started
   * it (agent delegation design, decision 41).
   */
  childRuns: (RunSnapshot & { parentRunId: string; parentCallId: string })[];
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
  /** Agents. Left out: sessions cannot pick one. */
  agents?: AgentStore;
  /** Skills. Left out: no run has any. */
  skills?: SkillStore;
  /**
   * The skill list for the system message, or undefined for none (skills
   * design, decisions 6, 11). It goes after the agent prompt and before
   * `systemPrompt`.
   */
  skillsPrompt?: (skills: readonly RunSkill[]) => string | undefined;
  /**
   * What `{{skills}}` expands to: one line per skill (placeholders design,
   * decision 8). Left out: it expands to nothing.
   */
  skillsList?: (skills: readonly RunSkill[]) => string;
  /**
   * Project and global files and notes for tools. Left out: tools see
   * session scope only.
   */
  entries?: EntryStore;
  /**
   * Global, project and agent schemas and data (schemas and data design).
   * Left out: tools see session scope only.
   */
  data?: DataStore;
  /** Checks schemas and data (Ajv). Left out: the data tools fail. */
  schemaChecker?: SchemaChecker;
  /**
   * Names of the schema and data tools. The schema list goes in the system
   * message only when the run offers one of them.
   */
  dataTools?: readonly string[];
  /**
   * The schema list alone, one per line. It is what `{{schemas}}` expands
   * to (decision 39). Empty for none.
   */
  schemasList?: (
    schemas: readonly {
      id: string;
      name: string;
      scope: SchemaScope;
      description: string;
    }[],
  ) => string;
  /**
   * The data list, one per line with the schema's name, the data's name and
   * its description.
   * It is what `{{data}}` expands to. Empty for none.
   */
  dataList?: (
    data: readonly { schema: string; name: string; description: string }[],
  ) => string;
  /**
   * The schema list with its instruction (decisions 37, 38), or undefined
   * for none. It goes after the skill list when no prompt has
   * `{{schemas}}` (decision 41).
   */
  schemasPrompt?: (
    schemas: readonly {
      id: string;
      name: string;
      scope: SchemaScope;
      description: string;
    }[],
  ) => string | undefined;
  /**
   * A system message put before the transcript of every model call; not
   * stored. Undefined: none. The global, project and agent prompts go
   * before it, in that order, in the same message (agents design 9; system
   * prompts design, decisions 1 and 2).
   */
  systemPrompt?: (session: SessionRow) => string | undefined;
  /** Generates memory note ids. Default: 16 random hex digits. */
  newNoteId?: () => string;
  /** Kept in step with session-scoped changes, when given. */
  index?: SearchIndex;
  /** The search tools' backend for a session. Left out: search fails. */
  search?: (session: SessionRow) => EntrySearch;
  /** Where tool errors and failed runs are recorded. Default: over `store.db`. */
  errors?: ErrorStore;
  /** App-wide events (`errors.changed`). Default: a new one. */
  events?: AppEvents;
  now?: () => string;
  newId?: () => string;
}

/** What a subagent run is told when it stops without handing back. */
const CHILD_REMINDER =
  "You have not handed back. If you are finished, call subagent_handback with your result. If you need something from the user, call ask_user.";

/** What `startChild` needs to start a subagent's run. */
interface ChildStart {
  /** The run and `start_subagent` call that started it. */
  parent: { runId: string; callId: string };
  task: string;
  depth: number;
  /** The parent run's signal. */
  signal: AbortSignal;
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
  /** Title calls in progress (auto-rename plan, step 3). */
  private readonly titleJobs = new Set<{
    controller: AbortController;
    done: Promise<void>;
  }>();
  private shuttingDown = false;
  private readonly now: () => string;
  private readonly newId: () => string;
  readonly tools: readonly Tool[];
  /** Tool errors and failed runs (error reporting plan, P4). */
  readonly errors: ErrorStore;
  /** App-wide events; `errors.changed` is published here. */
  readonly events: AppEvents;

  constructor(private readonly options: RunManagerOptions) {
    this.store = options.store;
    this.tools = options.tools ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.errors = options.errors ?? new ErrorStore(this.store.db, this.newId);
    this.events = options.events ?? new AppEvents();
  }

  /** Records an error and tells every window (error reporting plan, P6). */
  private recordError(error: NewError) {
    this.errors.record(error, this.now());
    this.events.publish({
      type: "errors.changed",
      data: { sessionId: error.sessionId },
    });
  }

  /**
   * Clears one session's errors, or every error the global console shows
   * when `sessionId` is left out (O2). Returns how many were deleted.
   */
  clearErrors(sessionId?: string): number {
    const cleared = this.errors.clear(sessionId);
    this.events.publish({
      type: "errors.changed",
      data: { sessionId: sessionId ?? null },
    });
    return cleared;
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
    const rename = this.wantsAutoRename(sessionId);
    this.store.addMessage(
      sessionId,
      this.newId(),
      { role: "user", content },
      this.now(),
    );
    const started = this.start(sessionId, null);
    if (rename) this.autoRename(sessionId, content);
    return started;
  }

  /**
   * Renames the session as the user asked and emits `session.renamed`
   * (auto-rename plan, decision 8).
   */
  renameSession(sessionId: string, title: string) {
    this.store.renameSession(sessionId, title);
    this.publishRename(sessionId, {
      title,
      source: "user",
      model: null,
      usage: null,
    });
  }

  /**
   * Whether the message about to be sent gets the session a title: the
   * setting is on, the session has no user message yet and its title is
   * still the default (decisions 4, 5).
   */
  private wantsAutoRename(sessionId: string): boolean {
    if (!this.options.settings().autoRename) return false;
    if (this.store.getSession(sessionId)?.title !== DEFAULT_TITLE) return false;
    return !this.store
      .listMessages(sessionId)
      .some((m) => m.message.role === "user");
  }

  /**
   * Gives the session a title from its first message, alongside the run
   * and independent of it (decisions 2, 10). With the model as the source,
   * a failed or stopped call, or one with nothing usable, falls back to the
   * message (decision 6, plan step 3). A title the user set in the meantime
   * is kept.
   */
  private autoRename(sessionId: string, content: string) {
    const settings = this.options.settings();
    const fallback = () => {
      const title = cleanTitle(content);
      if (title === "" || !this.store.renameSessionIfDefault(sessionId, title))
        return;
      this.publishRename(sessionId, {
        title,
        source: "message",
        model: null,
        usage: null,
      });
    };
    if (settings.autoRenameSource === "message") {
      fallback();
      return;
    }
    const session = this.store.getSession(sessionId);
    const model =
      settings.titleModel || session?.model || settings.model || null;
    const reasoningEffort =
      session?.reasoning_effort || settings.reasoningEffort || null;
    const controller = new AbortController();
    const job = { controller, done: Promise.resolve() };
    const run = async () => {
      try {
        const result = await requestTitle(
          this.options.model(settings),
          {
            prompt: settings.titlePrompt,
            message: content,
            model,
            reasoningEffort,
          },
          controller.signal,
        );
        const title = cleanTitle(result.text);
        if (title === "") return fallback();
        if (!this.store.renameSessionIfDefault(sessionId, title)) return;
        this.publishRename(sessionId, {
          title,
          source: "model",
          model,
          usage: result.usage,
        });
      } catch {
        try {
          fallback();
        } catch {
          // The database failed; the session keeps its title.
        }
      } finally {
        this.titleJobs.delete(job);
      }
    };
    this.titleJobs.add(job);
    job.done = run();
  }

  private publishRename(
    sessionId: string,
    data: Extract<HarnessEvent, { type: "session.renamed" }>["data"],
  ) {
    this.publish({
      runId: null,
      sessionId,
      time: this.now(),
      type: "session.renamed",
      data,
    });
  }

  /** Resolves when every title call in progress has ended (for tests). */
  async titlesSettled(): Promise<void> {
    await Promise.all([...this.titleJobs].map((j) => j.done));
  }

  /**
   * Continues the session. After an assistant message, continues that
   * message (assistant prefill). After a tool result (a run that stopped
   * between steps), starts the next step. The choices become the session's
   * before the run starts.
   */
  continueLast(sessionId: string, choices: RunChoices = {}): { runId: string } {
    this.requireIdle(sessionId);
    const last = this.store.listMessages(sessionId, "top").at(-1);
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

  /**
   * Stops a run. A subagent has no stop of its own (decision 38): stopping
   * it stops the run it belongs to, and its parent's signal reaches it.
   */
  cancel(runId: string): boolean {
    let run = this.active.get(runId);
    if (!run) return false;
    while (run.parent) {
      const up = this.active.get(run.parent.runId);
      if (!up) break;
      run = up;
    }
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
    // A tool that always asks can only be allowed once or denied.
    if (
      tool &&
      alwaysAsks(tool) &&
      (choice === "session" || choice === "always")
    ) {
      throw new RunError(
        `${tool.name} always asks; it can only be allowed once or denied.`,
        400,
      );
    }
    // The global setting would not change what the agent's own setting says.
    if (open.request.agentSetting && choice === "always") {
      throw new RunError(
        `The agent's own setting asks for ${open.request.name}; it can only be allowed once, for this session, or denied.`,
        400,
      );
    }
    if (answer.selection !== undefined) {
      if (choice !== "once") {
        throw new RunError(
          "Changes can only be picked one by one with once (schemas and data design, decision 34).",
          400,
        );
      }
      if (!open.hooks) {
        throw new RunError("This call has no changes to pick from.", 400);
      }
    }
    if (open.hooks && choice !== "deny") {
      // What the changes were worked out from changed since they were shown
      // (decision 30): the user refreshes them or rejects the call.
      if (open.hooks.stale()) {
        throw new RunError(
          "The data changed since this was asked. Refresh the changes or deny the call.",
          409,
        );
      }
      const errors = open.hooks.check(
        answer.selection ??
          (open.request.review ? selectAll(open.request.review) : {}),
      );
      if (errors.length > 0) {
        throw new RunError(
          `These changes cannot be applied:\n${errors.map((e) => `- ${e}`).join("\n")}`,
          400,
        );
      }
    }
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

  private openApproval(runId: string, requestId: string) {
    const run = this.active.get(runId);
    if (!run) throw new RunError("The run is not active.", 409);
    const open = run.approvals.get(requestId);
    if (!open) {
      throw new RunError("No open approval request with that id.", 404);
    }
    return open;
  }

  /**
   * Checks a selection for an open request with a review, without answering
   * it (decisions 30, 33): the problems with applying it, and whether the
   * changes are out of date. Left out: every change.
   */
  checkApproval(
    runId: string,
    requestId: string,
    selection?: Selection,
  ): { errors: string[]; stale: boolean } {
    const open = this.openApproval(runId, requestId);
    if (!open.hooks || !open.request.review) {
      throw new RunError("This call has no changes to check.", 400);
    }
    if (open.hooks.stale()) return { errors: [], stale: true };
    return {
      errors: open.hooks.check(selection ?? selectAll(open.request.review)),
      stale: false,
    };
  }

  /**
   * Works an open request's changes out again from the current data
   * (decision 30, Refresh). Returns the request with its new review.
   */
  refreshApproval(runId: string, requestId: string): ApprovalRequest {
    const open = this.openApproval(runId, requestId);
    if (!open.hooks) {
      throw new RunError("This call has no changes to refresh.", 400);
    }
    const review = open.hooks.refresh();
    if (!review) {
      throw new RunError(
        "The changes can no longer be worked out; deny the call.",
        409,
      );
    }
    open.request = { ...open.request, review };
    return open.request;
  }

  /**
   * Answers a form. Answers are checked against the form first (D8); the
   * stored result holds them as checked ("Other" text trimmed).
   */
  answerInput(runId: string, requestId: string, answer: InputAnswer) {
    const run = this.active.get(runId);
    if (!run) throw new RunError("The run is not active.", 409);
    const open = run.inputs.get(requestId);
    if (!open) throw new RunError("No open form with that id.", 404);
    let final = answer;
    if (answer.outcome === "answered") {
      const checked = checkAnswers(open.request.form, answer.answers);
      if (!checked.ok) {
        const problems = Object.entries(checked.errors)
          .map(([name, error]) => (name ? `${name}: ${error}` : error))
          .join(" ");
        throw new RunError(`The answers are not valid. ${problems}`, 400);
      }
      final = { outcome: "answered", answers: checked.answers };
    }
    run.inputs.delete(requestId);
    open.resolve(final);
  }

  snapshot(sessionId: string): Snapshot {
    const lastEventId = this.store.lastEventId(sessionId);
    const runs = [...this.active.values()].filter(
      (r) => r.sessionId === sessionId,
    );
    const describe = (run: ActiveRun): RunSnapshot => ({
      runId: run.runId,
      model: run.generation.model,
      reasoningEffort: run.generation.reasoningEffort,
      agent: run.agent,
      message: this.inFlight(this.store.runEvents(run.runId)),
      approvals: [...run.approvals.values()].map((a) => a.request),
      inputs: [...run.inputs.values()].map((i) => i.request),
    });
    const top = runs.find((r) => r.parent === null);
    return {
      lastEventId,
      activeRun: top ? describe(top) : null,
      childRuns: runs.flatMap((r) =>
        r.parent
          ? [
              {
                ...describe(r),
                parentRunId: r.parent.runId,
                parentCallId: r.parent.callId,
              },
            ]
          : [],
      ),
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
    // Stopped title calls fall back to the message (auto-rename plan).
    const titles = [...this.titleJobs];
    for (const job of titles) job.controller.abort();
    await Promise.all([...runs, ...titles].map((r) => r.done));
  }

  /**
   * After a crash: runs still marked running are ended as interrupted. The
   * partial message is saved from the stored events, and every tool call the
   * run made without a result gets an error result saying it was
   * interrupted; the tool is not run again (tools design 6.10). Open
   * approval requests and forms are withdrawn.
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

      for (const e of openRequests(events)) {
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

  /**
   * Records the user's changes to session schemas or data as an edit message
   * (schemas and data design, decision 4). Refused during a run (plan P4).
   */
  editSessionData(sessionId: string, ops: DataOp[]): { messageId: string } {
    this.requireIdle(sessionId);
    const messageId = this.newId();
    this.store.addMessage(
      sessionId,
      messageId,
      { role: "edit", content: dataEditNotice(ops), entries: [], dataOps: ops },
      this.now(),
    );
    this.publish({
      runId: null,
      sessionId,
      time: this.now(),
      type: "session.data_changed",
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

  /** The names of the tools that are always on now (Settings; design, decision 12). */
  alwaysOnTools(): Set<string> {
    return alwaysOnNames(this.store.db, this.tools);
  }

  /**
   * The tools a run gets with this agent (agents design 6; tool management
   * design, decisions 12, 15). A tool that is off for the whole harness, or
   * not available in this run (`available`), is not offered. With an agent,
   * a tool is offered when it is always on or the agent's grant allows it.
   */
  private toolsFor(agent: Agent | null, run: RunFacts): readonly Tool[] {
    const off = offNames(this.store.db);
    const offered = this.tools.filter(
      (t) => !off.has(t.name) && (t.available?.(run) ?? true),
    );
    if (!agent) return offered;
    const alwaysOn = this.alwaysOnTools();
    const allowed = new Set(allowedNames(agent.toolGrant, this.tools));
    return offered.filter((t) => alwaysOn.has(t.name) || allowed.has(t.name));
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
    const { runId } = this.launch(sessionId, continuing, null);
    return { runId };
  }

  /**
   * Runs `agentId` as a subagent of the run whose call started it, and waits
   * for it. It is a run of its own: stored, with its own approvals and
   * forms, answered by its own id (agent delegation design, decisions 1, 2).
   */
  private async startChild(
    sessionId: string,
    child: ChildStart,
    agentId: string,
  ): Promise<SubagentOutcome> {
    const agents = this.options.agents;
    const session = this.store.getSession(sessionId);
    const agent = agents?.get(agentId);
    const fail = (
      name: string,
      reason: "failed" | "no_output",
      message: string,
    ): SubagentOutcome => ({
      ok: false,
      agent: name,
      reason,
      message,
      text: "",
    });
    if (!agents || !session || !agent) {
      return fail(agentId, "failed", "No agent with that id.");
    }
    if (!agents.usableIn(agent, session.project_id)) {
      return fail(agent.name, "failed", "This session cannot use that agent.");
    }
    if (!agent.subagent) {
      return fail(agent.name, "failed", "That agent is not startable.");
    }
    const { finished } = this.launch(sessionId, null, { ...child, agent });
    const result: LoopResult | undefined = await finished;
    const text = result?.output?.trim() ?? "";
    const gone = (
      reason: "failed" | "cancelled" | "iteration_limit",
      message: string,
    ): SubagentOutcome => ({
      ok: false,
      agent: agent.name,
      reason,
      message,
      text,
    });
    if (!result) return gone("failed", "It stopped unexpectedly.");
    switch (result.reason) {
      case "handed_back":
      case "stop":
        return text === ""
          ? fail(agent.name, "no_output", "It ended with no output.")
          : { ok: true, agent: agent.name, output: result.output ?? text };
      case "iteration_limit":
        return gone(
          "iteration_limit",
          `It used all ${this.options.settings().loopLimit} of its model calls.`,
        );
      case "cancelled":
        return gone("cancelled", "It was cancelled.");
      case "failed":
        return gone("failed", result.error ?? "It failed.");
    }
  }

  /**
   * Starts a run: a top-level one, or (`child` set) a subagent's. Returns
   * its id and a promise of how the loop ended.
   */
  private launch(
    sessionId: string,
    continuing: { messageId: string; message: AssistantMessage } | null,
    child: (ChildStart & { agent: Agent }) | null,
  ): { runId: string; finished: Promise<LoopResult | undefined> } {
    const settings = this.options.settings();
    const runId = this.newId();
    const depth = child?.depth ?? 0;
    // The session's choices, else the default settings. Empty: not sent.
    const session = this.store.getSession(sessionId);
    // The session's agent as it is now; the run keeps this version to the
    // end (agents design 13, 24). One it can no longer use counts as none.
    // A subagent's run uses the agent it was started as.
    const picked =
      session?.agent_id != null
        ? this.options.agents?.get(session.agent_id)
        : undefined;
    const agent = child
      ? child.agent
      : picked &&
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
    const project = session?.project_id
      ? this.store.getProject(session.project_id)
      : undefined;
    // The skills in scope, as they are now; the run keeps them to the end
    // (skills design, decisions 1, 13).
    const skills: readonly RunSkill[] =
      this.options.skills?.inScope(
        session?.project_id ?? null,
        agent?.id ?? null,
      ) ?? [];
    const tools = this.toolsFor(agent, {
      hasSkills: skills.length > 0,
      isChild: child !== null,
      canStartSubagent: depth < settings.subagentDepth,
    });
    // The schemas in scope, listed only when the run offers a schema or data
    // tool (schemas and data design, decisions 37, 41): global, project,
    // agent, then the session's own.
    const dataTools = new Set(this.options.dataTools ?? []);
    const dataOwner = {
      projectId: session?.project_id ?? null,
      agentId: agent?.id ?? null,
    };
    const schemas = tools.some((t) => dataTools.has(t.name))
      ? [
          ...(this.options.data?.inScope(dataOwner) ?? []),
          ...[
            ...replaySessionData(
              this.store.listMessages(sessionId).map((m) => m.message),
            ).schemas.values(),
          ]
            .filter((s) => !s.deleted)
            .map((s) => ({ ...s, scope: "session" as const })),
        ]
      : [];
    // The data in scope, listed with the schemas and only when they are:
    // global, project, agent, then the session's own. Data whose schema is
    // not in scope is left out.
    const schemaNames = new Map(schemas.map((s) => [s.id, s.name]));
    const dataItems =
      schemas.length > 0
        ? [
            ...(this.options.data?.dataInScope(dataOwner) ?? []),
            ...[
              ...replaySessionData(
                this.store.listMessages(sessionId).map((m) => m.message),
              ).data.values(),
            ].filter((d) => !d.deleted),
          ].flatMap((d) => {
            const schema = schemaNames.get(d.schemaId);
            return schema === undefined
              ? []
              : [{ schema, name: d.name, description: d.description }];
          })
        : [];
    const schemasText = this.options.schemasPrompt?.(schemas);
    // The prompts the user wrote may place the lists with {{skills}},
    // {{tools}}, {{schemas}} and {{data}}; they are filled in once, here,
    // from what this run has
    // (placeholders design, decisions 1, 6, 12). Where no prompt has
    // {{skills}} the skill list goes after them, as before (decision 10).
    // A subagent's system message is built the same way, with its own line
    // at the very end: the agent's, else the global one (decisions 14, 17).
    const childLine = child
      ? (agent?.childPrompt ?? settings.childPrompt)
      : undefined;
    const written = [
      settings.systemPrompt,
      project?.system_prompt,
      agent?.prompt,
    ];
    const values = {
      skills: this.options.skillsList?.(skills) ?? "",
      tools: toolsList(tools),
      schemas: this.options.schemasList?.(schemas) ?? "",
      data: this.options.dataList?.(dataItems) ?? "",
    };
    const expanded = written.map((p) =>
      p === undefined ? p : expandPlaceholders(p, values),
    );
    const placed = written.some((p) => usesPlaceholder(p, "skills"));
    const schemasPlaced = written.some((p) => usesPlaceholder(p, "schemas"));
    // Global, project and agent prompts, then the skill list, then the files
    // and memory instruction (system prompts design, decisions 1 and 2;
    // skills design 11). Empty ones are left out.
    const system =
      [
        ...expanded,
        placed ? undefined : this.options.skillsPrompt?.(skills),
        schemasPlaced ? undefined : schemasText,
        base,
        childLine,
      ]
        .filter((p): p is string => p !== undefined && p.trim() !== "")
        .join("\n\n") || undefined;
    this.store.createRun({
      id: runId,
      sessionId,
      kind: "loop",
      now: this.now(),
      generation,
      ...(child ? { parent: child.parent } : {}),
      // Kept so a session can be exported for debugging with the exact
      // system message and tools the model was given.
      request: {
        ...(system ? { systemPrompt: system } : {}),
        tools: toolDefinitions(tools),
      },
    });

    const controller = new AbortController();
    // Cancelling the parent stops its subagent too (decision 38).
    if (child) {
      if (child.signal.aborted) controller.abort();
      else
        child.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const approvals = new Map<string, OpenApproval>();
    const inputs = new Map<string, OpenInput>();
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
      // Pages showing global, project or agent data refetch (schemas and
      // data design). Session data refreshes from the session's own events.
      if (
        message.role === "tool" &&
        !message.isError &&
        dataTools.has(message.name)
      ) {
        this.events.publish({ type: "data.changed", data: {} });
      }
    };

    // A subagent's first message is the task, saved as its own (decision 28).
    // Its request holds only its own messages; a top-level run's leaves out
    // every subagent's (decision 29).
    if (child) {
      const taskId = this.newId();
      const task: UserMessage = { role: "user", content: child.task };
      saveMessage(taskId, task);
    }
    const request: ChatRequest = {
      kind: "chat",
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        ...this.store
          .listMessages(sessionId, child ? { run: runId } : "top")
          .map((m) => m.message),
      ],
      control,
      ...(generation.model ? { model: generation.model } : {}),
      ...(generation.reasoningEffort
        ? { reasoningEffort: generation.reasoningEffort }
        : {}),
    };

    // A ToolRunError is recorded as its tool error only (O4).
    let endedByTool = false;
    const execute = async (): Promise<LoopResult | undefined> => {
      let loopResult: LoopResult | undefined;
      try {
        const result = await runLoop(this.options.model(settings), request, {
          runId,
          sessionId,
          emit,
          signal: controller.signal,
          newId: this.newId,
          now: this.now,
          ...(continuing ? { continueMessage: continuing } : {}),
          tools,
          skills,
          ...(runAgent ? { agent: runAgent } : {}),
          ...(child
            ? {
                parentRunId: child.parent.runId,
                parentCallId: child.parent.callId,
                child: {
                  reminders: agent?.childReminders ?? settings.childReminders,
                  reminderText: CHILD_REMINDER,
                },
              }
            : {}),
          // Files, notes, schemas and data are rebuilt from every message of
          // the session, subagents' included (decision 30).
          sessionMessages: () =>
            this.store.listMessages(sessionId).map((m) => m.message),
          subagents: {
            depth,
            canStart: depth < settings.subagentDepth,
            start: ({ agentId, task, callId }) =>
              this.startChild(
                sessionId,
                {
                  parent: { runId, callId },
                  task,
                  depth: depth + 1,
                  signal: controller.signal,
                },
                agentId,
              ),
          },
          projectId: session?.project_id ?? null,
          projectName: project?.name ?? null,
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
          ...(this.options.data
            ? { sharedData: this.options.data.shared(dataOwner) }
            : {}),
          ...(this.options.schemaChecker
            ? { schemaChecker: this.options.schemaChecker }
            : {}),
          ...(this.options.search && session
            ? { searchEntries: this.options.search(session) }
            : {}),
          ...(session
            ? {
                projects: projectAccess({
                  store: this.store,
                  entries: this.options.entries,
                  agents: this.options.agents,
                  events: this.events,
                  session,
                  author: { by: "model", sessionId, runId },
                  newId: this.newId,
                  now: this.now,
                  newNoteId: this.options.newNoteId,
                }),
                agents: agentAccess({
                  store: this.store,
                  agents: this.options.agents,
                  session,
                  runAgent: agent,
                  tools: this.tools,
                }),
              }
            : {}),
          copyLimit: settings.copyLimit,
          maxIterations: settings.loopLimit,
          // The agent's own setting, then the tool's (agent tool approval
          // design, section 3). The agent is the one this run started with.
          needsApproval: (tool) =>
            toolApproval(this.store.db, tool, agent).ask &&
            (alwaysAsks(tool) ||
              !this.store.isToolAllowedForSession(sessionId, tool.name)),
          agentDecides: (tool) =>
            toolApproval(this.store.db, tool, agent).byAgent,
          approve: (req, signal, hooks) =>
            new Promise<ApprovalAnswer>((resolve) => {
              approvals.set(req.requestId, { request: req, resolve, hooks });
              signal.addEventListener(
                "abort",
                () => approvals.delete(req.requestId),
                { once: true },
              );
            }),
          requestInput: (req, signal) =>
            new Promise<InputAnswer>((resolve) => {
              inputs.set(req.requestId, { request: req, resolve });
              signal.addEventListener(
                "abort",
                () => inputs.delete(req.requestId),
                { once: true },
              );
            }),
          onMessage: saveMessage,
          reportError: (report) => {
            if (report.endsRun) endedByTool = true;
            this.recordError({
              sessionId,
              runId,
              messageId: report.messageId,
              callId: report.callId,
              source: "tool",
              kind: report.kind,
              toolName: report.toolName,
              message: report.message,
              details: report.details,
              stack: report.stack,
              arguments: report.arguments,
            });
          },
          cancelledText: () => (this.shuttingDown ? STOPPED_CALL : undefined),
        });
        loopResult = result;
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
        if (result.reason === "failed" && !endedByTool) {
          this.recordError({
            sessionId,
            runId,
            source: "run",
            kind: "run_failed",
            message: result.error ?? "",
          });
        }
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
          this.recordError({
            sessionId,
            runId,
            source: "run",
            kind: "run_failed",
            message,
            stack: err instanceof Error ? err.stack : undefined,
          });
        } catch {
          // The database itself failed; recover() will handle it next start.
        }
      } finally {
        this.active.delete(runId);
      }
      return loopResult;
    };

    const run: ActiveRun = {
      runId,
      sessionId,
      generation,
      agent: runAgent,
      controller,
      control,
      approvals,
      inputs,
      parent: child?.parent ?? null,
      done: Promise.resolve(),
    };
    this.active.set(runId, run);
    const finished = execute();
    run.done = finished.then(() => undefined);
    return { runId, finished };
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

/** Ids of approval requests and forms with no answer or withdrawal. */
function openRequests(events: readonly StoredEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type === "tool.approval_requested" || e.type === "input.requested")
      open.add(e.data.requestId);
    else if (
      e.type === "tool.approval_resolved" ||
      e.type === "input.resolved" ||
      e.type === "request.cancel"
    )
      open.delete(e.data.requestId);
  }
  return [...open];
}
