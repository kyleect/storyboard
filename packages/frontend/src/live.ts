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
import { appEventsUrl, entriesKey, eventsUrl, type SessionDetail } from "./api";

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

export interface LiveRun {
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
  /** The latest running token count from the stream. */
  usage?: Usage;
}

interface LiveState {
  runs: Record<string, LiveRun | undefined>;
  connected: Record<string, boolean | undefined>;
  set: (sessionId: string, run: LiveRun | undefined) => void;
  update: (sessionId: string, f: (run: LiveRun) => LiveRun) => void;
  setConnected: (sessionId: string, connected: boolean) => void;
}

export const useLive = create<LiveState>((set) => ({
  runs: {},
  connected: {},
  set: (sessionId, run) =>
    set((s) => ({ runs: { ...s.runs, [sessionId]: run } })),
  update: (sessionId, f) =>
    set((s) => {
      const run = s.runs[sessionId];
      return run ? { runs: { ...s.runs, [sessionId]: f(run) } } : s;
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
    live.set(sessionId, snapshot ?? undefined);

    let lastId = detail.lastEventId;
    // Runs whose model has started answering (so it is loaded now).
    const answering = new Set<string>();
    // A model is loaded by its first request, so what llama-server reports
    // about models (status, reasoning levels) can change during a run.
    const refreshModelInfo = () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      void queryClient.invalidateQueries({ queryKey: ["reasoning-levels"] });
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
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          void queryClient.invalidateQueries({ queryKey: ["trash"] });
          void queryClient.invalidateQueries({
            queryKey: ["session", sessionId],
          });
          void navigate({ to: "/" });
          break;
        case "session.entries_changed":
          // An edit to session-scoped files or notes added a message.
          void queryClient.invalidateQueries({
            queryKey: ["session", sessionId],
          });
          void queryClient.invalidateQueries({
            queryKey: entriesKey({ scope: "session", id: sessionId }),
          });
          break;
        case "run.started":
          state.set(sessionId, {
            runId: event.runId,
            model: event.data.model ?? null,
            reasoningEffort: event.data.reasoningEffort ?? null,
            agent: event.data.agent ?? null,
            message: null,
            approvals: [],
            inputs: [],
          });
          break;
        case "message.started": {
          const cached = queryClient.getQueryData<SessionDetail>([
            "session",
            sessionId,
          ]);
          const existing = cached?.messages.find(
            (m) => m.id === event.data.messageId,
          );
          const continuing = event.data.continuing ?? false;
          state.update(sessionId, (run) => ({
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
          const run = useLive.getState().runs[sessionId];
          queryClient.setQueryData<SessionDetail>(
            ["session", sessionId],
            (old) => {
              if (!old || event.data.message.content.length === 0) return old;
              const stored = {
                id: event.data.messageId,
                message: event.data.message,
                model: run?.model ?? null,
                reasoningEffort: run?.reasoningEffort ?? null,
                agent: run?.agent ?? null,
                usage: event.data.usage ?? null,
              };
              const at = old.messages.findIndex(
                (m) => m.id === event.data.messageId,
              );
              const messages = [...old.messages];
              if (at === -1) messages.push(stored);
              else messages[at] = stored;
              return { ...old, messages };
            },
          );
          state.update(sessionId, (r) => ({ ...r, message: null }));
          break;
        }
        case "tool.result":
          // The result message is stored before this event.
          void queryClient.invalidateQueries({
            queryKey: ["session", sessionId],
          });
          // The session's Files and Memory tabs update live (decision 35).
          if (/^(files|memory)_/.test(event.data.name)) {
            void queryClient.invalidateQueries({
              queryKey: entriesKey({ scope: "session", id: sessionId }),
            });
          }
          break;
        case "tool.approval_requested":
          state.update(sessionId, (run) => ({
            ...run,
            approvals: [...run.approvals, event.data],
          }));
          break;
        case "input.requested":
          state.update(sessionId, (run) => ({
            ...run,
            inputs: [...run.inputs, event.data],
          }));
          break;
        case "tool.approval_resolved":
        case "input.resolved":
        case "request.cancel":
          state.update(sessionId, (run) => ({
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
          }
          answering.delete(event.runId);
          refreshModelInfo();
          // The session lists show each session's latest usage.
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          void queryClient
            .invalidateQueries({ queryKey: ["session", sessionId] })
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
          state.update(sessionId, (run) => {
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
interface AppEvent {
  type: "agents.changed";
  data: {
    agentId: string;
    projectId: string | null;
    clearedSessions: string[];
  };
}

/**
 * Listens to the app-wide stream for the whole app. Its events are not
 * replayed, so agent data is refetched whenever the stream opens or
 * reopens, then on each `agents.changed`.
 */
export function useAppEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refreshAgents = () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["session-agents"] });
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
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        const event = JSON.parse(msg.data) as AppEvent;
        if (event.type !== "agents.changed") return;
        refreshAgents();
        // A deleted agent is cleared from the sessions that had it picked.
        for (const id of event.data.clearedSessions) {
          void queryClient.invalidateQueries({ queryKey: ["session", id] });
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
