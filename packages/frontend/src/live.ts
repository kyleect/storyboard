import { useEffect } from "react";
import { create } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import {
  applyMessageEvent,
  type ApprovalRequest,
  type ContentBlock,
  type HarnessEvent,
  type InputRequest,
  type RunAgent,
  type Usage,
} from "@harness/core";
import {
  appEventsUrl,
  eventsUrl,
  type SessionDetail,
  type StoredMessage,
} from "./api";
import {
  agentKeys,
  dataKeys,
  entryKeys,
  errorKeys,
  mcpKeys,
  modelKeys,
  projectKeys,
  runKeys,
  sessionKeys,
  skillKeys,
  workspaceKeys,
  toolKeys,
  trashKeys,
} from "./queries";

/*
 * The in-flight run of each session, built from streamed events. A run can
 * write several messages (tools design, section 4): each finished message
 * goes into the cached transcript, tool results are refetched, and when the
 * run ends the transcript is refetched and the live entry cleared.
 */

export interface LiveMessage {
  messageId: string;
  continuing: boolean;
  content: readonly ContentBlock[];
}

/** What is tracked for each run in progress. */
export interface LiveRunState {
  runId: string;
  model: string | null;
  reasoningEffort: string | null;
  /** The agent version the run uses; null: none. */
  agent: RunAgent | null;
  /** The message being written now; null while a tool runs. */
  message: LiveMessage | null;
  /** Approval requests waiting for an answer, oldest first. */
  approvals: ApprovalRequest[];
  /** Forms waiting for an answer, oldest first (input forms design). */
  inputs: InputRequest[];
  /** Messages the user sent that the run has not read yet, oldest first. */
  userMessages: string[];
  /** The latest running token count from the stream. */
  usage?: Usage;
}

/** The session's top-level run, with the subagents' runs it started. */
export interface LiveRun extends LiveRunState {
  /** Subagents' runs in progress, by run id (agent delegation design). */
  children: Record<string, LiveChild>;
}

/** A subagent's run, tied to the call that started it. */
export interface LiveChild extends LiveRunState {
  parentRunId: string;
  parentCallId: string;
}

/** The runs of a session in progress, the top-level one first. */
export function liveRuns(run: LiveRun | undefined): LiveRunState[] {
  return run ? [run, ...Object.values(run.children)] : [];
}

/** The run with this id, top-level or a subagent's. */
export function findLiveRun(
  run: LiveRun | undefined,
  runId: string | null,
): LiveRunState | undefined {
  if (!run) return undefined;
  return (runId !== null ? run.children[runId] : undefined) ?? run;
}

interface LiveState {
  runs: Record<string, LiveRun | undefined>;
  connected: Record<string, boolean | undefined>;
  set: (sessionId: string, run: LiveRun | undefined) => void;
  /**
   * Changes the run `runId` names: a subagent's, or else the top-level run
   * (events of a run that is not known apply to the top-level one).
   */
  update: (
    sessionId: string,
    runId: string | null,
    f: (run: LiveRunState) => LiveRunState,
  ) => void;
  addChild: (sessionId: string, child: LiveChild) => void;
  removeChild: (sessionId: string, runId: string) => void;
  setConnected: (sessionId: string, connected: boolean) => void;
}

export const useLive = create<LiveState>((set) => ({
  runs: {},
  connected: {},
  set: (sessionId, run) =>
    set((s) => ({ runs: { ...s.runs, [sessionId]: run } })),
  update: (sessionId, runId, f) =>
    set((s) => {
      const run = s.runs[sessionId];
      if (!run) return s;
      const child = runId !== null ? run.children[runId] : undefined;
      const next: LiveRun = child
        ? {
            ...run,
            children: {
              ...run.children,
              [child.runId]: { ...child, ...f(child) },
            },
          }
        : { ...run, ...f(run) };
      return { runs: { ...s.runs, [sessionId]: next } };
    }),
  addChild: (sessionId, child) =>
    set((s) => {
      const run = s.runs[sessionId];
      return run
        ? {
            runs: {
              ...s.runs,
              [sessionId]: {
                ...run,
                children: { ...run.children, [child.runId]: child },
              },
            },
          }
        : s;
    }),
  removeChild: (sessionId, runId) =>
    set((s) => {
      const run = s.runs[sessionId];
      if (!run?.children[runId]) return s;
      const children = Object.fromEntries(
        Object.entries(run.children).filter(([id]) => id !== runId),
      );
      return { runs: { ...s.runs, [sessionId]: { ...run, children } } };
    }),
  setConnected: (sessionId, connected) =>
    set((s) => ({ connected: { ...s.connected, [sessionId]: connected } })),
}));

/**
 * Subscribes to a session's events once its detail has loaded. Starts from
 * the snapshot (in-flight message and last event id) and applies the rest,
 * reconnecting after the last event received when the stream drops.
 */
export function useSessionEvents(
  sessionId: string,
  detail: SessionDetail | undefined,
) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ready = detail !== undefined;

  useEffect(() => {
    if (!detail) return;
    const live = useLive.getState();
    const snapshot = detail.activeRun;
    live.set(
      sessionId,
      snapshot
        ? {
            ...snapshot,
            children: Object.fromEntries(
              detail.childRuns.map((c) => [c.runId, c]),
            ),
          }
        : undefined,
    );

    let lastId = detail.lastEventId;
    // Runs whose model has started answering (so it is loaded now).
    const answering = new Set<string>();
    // A model is loaded by its first request, so what llama-server reports
    // about models (status, reasoning levels) can change during a run.
    const refreshModelInfo = () => {
      void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
      void queryClient.invalidateQueries({
        queryKey: modelKeys.reasoningLevels(),
      });
    };
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;

    const onMessage = (msg: MessageEvent<string>) => {
      if (msg.lastEventId) lastId = Number(msg.lastEventId);
      const event = JSON.parse(msg.data) as HarnessEvent;
      const state = useLive.getState();

      switch (event.type) {
        case "session.trashed":
          // Trashed here or in another window (sessions and projects
          // design, Q7a).
          void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
          void queryClient.invalidateQueries({ queryKey: trashKeys.all });
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void navigate({ to: "/" });
          break;
        case "session.entries_changed":
          // An edit to session-scoped files or notes added a message.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: entryKeys.inScope({ scope: "session", id: sessionId }),
          });
          break;
        case "session.data_changed":
          // An edit to session schemas or data added a message.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({ queryKey: dataKeys.all });
          break;
        case "session.transcript_changed":
          // A message was edited, or the session moved to another branch or
          // had one deleted or restored, here or in another window. The
          // files, notes, data and subagents follow the line shown.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: entryKeys.inScope({ scope: "session", id: sessionId }),
          });
          void queryClient.invalidateQueries({ queryKey: dataKeys.all });
          void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
          if (event.data.reason !== "edit")
            void queryClient.invalidateQueries({ queryKey: trashKeys.all });
          break;
        case "session.agent_changed":
          // A tool changed the session's agent; the picker reads it from
          // the session (agent tools design, Q18).
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          break;
        case "session.renamed":
          // Renamed automatically or by the user, here or in another
          // window (auto-rename plan, decision 8).
          queryClient.setQueryData<SessionDetail>(
            sessionKeys.detail(sessionId),
            (old) =>
              old && {
                ...old,
                session: { ...old.session, title: event.data.title },
              },
          );
          void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
          void queryClient.invalidateQueries({ queryKey: trashKeys.all });
          break;
        case "run.started": {
          const started = {
            runId: event.runId,
            model: event.data.model ?? null,
            reasoningEffort: event.data.reasoningEffort ?? null,
            agent: event.data.agent ?? null,
            message: null,
            approvals: [],
            inputs: [],
            userMessages: [],
          };
          const { parentRunId, parentCallId } = event.data;
          if (parentRunId && parentCallId) {
            // A subagent's run: kept under the run that started it, so the
            // top-level run is not replaced (agent delegation design).
            state.addChild(sessionId, {
              ...started,
              parentRunId,
              parentCallId,
            });
          } else {
            state.set(sessionId, { ...started, children: {} });
          }
          break;
        }
        case "message.started": {
          const cached = queryClient.getQueryData<SessionDetail>(
            sessionKeys.detail(sessionId),
          );
          const existing = cached?.messages.find(
            (m) => m.id === event.data.messageId,
          );
          const continuing = event.data.continuing ?? false;
          state.update(sessionId, event.runId, (run) => ({
            ...run,
            message: {
              messageId: event.data.messageId,
              continuing,
              content:
                continuing && existing?.message.role === "assistant"
                  ? existing.message.content
                  : [],
            },
          }));
          break;
        }
        case "message.finished": {
          // The message is stored before this event; show it as stored.
          const top = useLive.getState().runs[sessionId];
          const run = findLiveRun(top, event.runId);
          const parentCallId =
            (event.runId !== null ? top?.children[event.runId] : undefined)
              ?.parentCallId ?? null;
          queryClient.setQueryData<SessionDetail>(
            sessionKeys.detail(sessionId),
            (old) => {
              if (!old || event.data.message.content.length === 0) return old;
              const at = old.messages.findIndex(
                (m) => m.id === event.data.messageId,
              );
              // Where the message sits in the tree is not in the event; a
              // continued message keeps what it had, a new one has no
              // siblings yet.
              const stored: StoredMessage = {
                id: event.data.messageId,
                message: event.data.message,
                model: run?.model ?? null,
                reasoningEffort: run?.reasoningEffort ?? null,
                agent: run?.agent ?? null,
                usage: event.data.usage ?? null,
                runId: event.runId,
                parentCallId,
                parentId: old.messages[at]?.parentId ?? null,
                branches: old.messages[at]?.branches ?? null,
              };
              const messages = [...old.messages];
              if (at === -1) messages.push(stored);
              else messages[at] = stored;
              return { ...old, messages };
            },
          );
          state.update(sessionId, event.runId, (r) => ({
            ...r,
            message: null,
          }));
          break;
        }
        case "tool.result":
          // The result message is stored before this event.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          // The Data tab and the data pages update live (schemas and data
          // design).
          if (/^(schemas?|data)_/.test(event.data.name)) {
            void queryClient.invalidateQueries({ queryKey: dataKeys.all });
          }
          // The session's Files and Memory tabs update live (decision 35).
          if (/^(files|memory)_/.test(event.data.name)) {
            void queryClient.invalidateQueries({
              queryKey: entryKeys.inScope({ scope: "session", id: sessionId }),
            });
          }
          // The session's errors panel (error reporting plan, P6).
          if (event.data.isError) {
            void queryClient.invalidateQueries({
              queryKey: errorKeys.list({ sessionId }),
            });
          }
          break;
        case "user.message":
          // The run read the oldest message that was waiting; it is stored
          // before this event.
          state.update(sessionId, event.runId, (run) => ({
            ...run,
            userMessages: run.userMessages.slice(1),
          }));
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          break;
        case "tool.approval_requested":
          state.update(sessionId, event.runId, (run) => ({
            ...run,
            approvals: [...run.approvals, event.data],
          }));
          break;
        case "input.requested":
          state.update(sessionId, event.runId, (run) => ({
            ...run,
            inputs: [...run.inputs, event.data],
          }));
          break;
        case "tool.approval_resolved":
        case "input.resolved":
        case "request.cancel":
          state.update(sessionId, event.runId, (run) => ({
            ...run,
            approvals: run.approvals.filter(
              (a) => a.requestId !== event.data.requestId,
            ),
            inputs: run.inputs.filter(
              (i) => i.requestId !== event.data.requestId,
            ),
          }));
          break;
        case "run.finished":
        case "run.failed":
        case "run.interrupted":
          if (event.type === "run.failed") {
            notifications.show({
              color: "red",
              title: "Run failed",
              message: event.data.error,
            });
            void queryClient.invalidateQueries({
              queryKey: errorKeys.list({ sessionId }),
            });
          }
          answering.delete(event.runId);
          refreshModelInfo();
          if (
            event.runId &&
            useLive.getState().runs[sessionId]?.children[event.runId]
          ) {
            const unread =
              useLive.getState().runs[sessionId]?.children[event.runId]
                ?.userMessages ?? [];
            if (unread.length > 0) {
              notifications.show({
                color: "yellow",
                title: "Message not delivered",
                message: `The subagent finished before it read ${
                  unread.length === 1 ? "this message" : "these messages"
                }: ${unread.join(" | ")}`,
                autoClose: false,
              });
            }
            // A subagent's run ended; the run that started it carries on. Its
            // messages come from the refetch.
            void queryClient
              .invalidateQueries({ queryKey: sessionKeys.detail(sessionId) })
              .then(() =>
                useLive
                  .getState()
                  .removeChild(sessionId, event.runId as string),
              );
            break;
          }
          // The session lists show each session's latest usage.
          void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
          void queryClient
            .invalidateQueries({ queryKey: sessionKeys.detail(sessionId) })
            .then(() => {
              const current = useLive.getState().runs[sessionId];
              if (current?.runId === event.runId)
                useLive.getState().set(sessionId, undefined);
            });
          break;
        default:
          if (
            (event.type === "text.delta" || event.type === "reasoning.delta") &&
            !answering.has(event.runId)
          ) {
            answering.add(event.runId);
            refreshModelInfo();
          }
          state.update(sessionId, event.runId, (run) => {
            const usage =
              (event.type === "text.delta" ||
                event.type === "reasoning.delta") &&
              event.data.usage
                ? event.data.usage
                : run.usage;
            const message = run.message
              ? {
                  ...run.message,
                  content: applyMessageEvent(
                    run.message.content,
                    run.message.messageId,
                    event,
                  ),
                }
              : null;
            return { ...run, message, ...(usage ? { usage } : {}) };
          });
      }
    };

    /*
     * EventSource reconnects on its own after a dropped connection, but gives
     * up for good when a reconnect gets an error status, which is what the
     * dev proxy returns while the backend restarts. Then open a new one that
     * resumes after the last event received.
     */
    const connect = () => {
      source = new EventSource(eventsUrl(sessionId, lastId));
      source.onopen = () => {
        delay = 500;
        useLive.getState().setConnected(sessionId, true);
      };
      source.onerror = () => {
        useLive.getState().setConnected(sessionId, false);
        if (source?.readyState === EventSource.CLOSED) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 5000);
        }
      };
      source.onmessage = onMessage;
    };
    connect();

    return () => {
      clearTimeout(retry);
      source?.close();
      useLive.getState().setConnected(sessionId, false);
    };
    // Connect once per session, after the first load; later refetches must
    // not reset the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ready]);
}

/** An event on the app-wide stream (agents plan, P7). */
type AppEvent =
  | {
      type: "agents.changed";
      data: {
        agentId: string;
        projectId: string | null;
        clearedSessions: string[];
      };
    }
  | {
      /** A tool created a project (agent tools design, Q17). */
      type: "projects.changed";
      data: { projectId: string };
    }
  | {
      type: "skills.changed";
      data: {
        skillId: string;
        projectId: string | null;
        agentId: string | null;
      };
    }
  | {
      /** An MCP server or its connection changed (MCP design). */
      type: "mcp.changed";
      data: { serverId: string };
    }
  | {
      /** Errors recorded or cleared (error reporting plan, P6). */
      type: "errors.changed";
      data: { sessionId: string | null };
    }
  | {
      /** Global, project or agent data changed (schemas and data design). */
      type: "data.changed";
      data: Record<string, never>;
    }
  | {
      /** A workspace, attachment or grant changed (files unification design). */
      type: "workspaces.changed";
      data: Record<string, never>;
    }
  | {
      /** A run started, ended, or began or stopped waiting for the user. */
      type: "runs.changed";
      data: { sessionId: string; runId: string };
    };

/**
 * Listens to the app-wide stream for the whole app. Its events are not
 * replayed, so agent data and errors are refetched whenever the stream
 * opens or reopens, then on each `agents.changed`, `projects.changed`,
 * `skills.changed`, `mcp.changed`, `runs.changed` or
 * `errors.changed`.
 */
export function useAppEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refreshAgents = () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.pickableAgents(),
      });
    };
    const refreshSkills = () =>
      void queryClient.invalidateQueries({ queryKey: skillKeys.all });
    const refreshErrors = () =>
      void queryClient.invalidateQueries({ queryKey: errorKeys.all });
    const refreshProjects = () =>
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    const refreshWorkspaces = () =>
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    const refreshData = () =>
      void queryClient.invalidateQueries({ queryKey: dataKeys.all });
    const refreshRuns = () =>
      void queryClient.invalidateQueries({ queryKey: runKeys.active() });
    // A server's tools come and go with its connection, so the tool lists
    // (settings, agent editor) change with it.
    const refreshMcp = () => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.all });
      void queryClient.invalidateQueries({ queryKey: toolKeys.list() });
      void queryClient.invalidateQueries({ queryKey: toolKeys.selectable() });
      void queryClient.invalidateQueries({
        queryKey: toolKeys.approvals(),
      });
    };
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const connect = () => {
      source = new EventSource(appEventsUrl());
      source.onopen = () => {
        delay = 500;
        // Anything that changed before the stream opened was not sent.
        refreshAgents();
        refreshSkills();
        refreshErrors();
        refreshProjects();
        refreshData();
        refreshMcp();
        refreshWorkspaces();
        refreshRuns();
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        const event = JSON.parse(msg.data) as AppEvent;
        if (event.type === "runs.changed") {
          refreshRuns();
          return;
        }
        if (event.type === "errors.changed") {
          // Every list: the global one shows every session's errors.
          refreshErrors();
          return;
        }
        if (event.type === "projects.changed") {
          refreshProjects();
          return;
        }
        if (event.type === "skills.changed") {
          refreshSkills();
          return;
        }
        if (event.type === "workspaces.changed") {
          refreshWorkspaces();
          return;
        }
        if (event.type === "data.changed") {
          refreshData();
          return;
        }
        if (event.type === "mcp.changed") {
          refreshMcp();
          return;
        }
        if (event.type !== "agents.changed") return;
        refreshAgents();
        // A deleted agent is cleared from the sessions that had it picked.
        for (const id of event.data.clearedSessions) {
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(id),
          });
        }
      };
      // EventSource reconnects on its own after a dropped connection, but
      // gives up on some errors (CLOSED); reconnect then with a backoff.
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 5000);
        }
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [queryClient]);
}
