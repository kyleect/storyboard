import { useEffect } from "react";
import { create } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  applyMessageEvent,
  type ContentBlock,
  type HarnessEvent,
  type Usage,
} from "@harness/core";
import { eventsUrl, type SessionDetail } from "./api";

/*
 * The in-flight run of each session, built from streamed events.
 * When a run ends, the transcript is refetched and the live entry cleared.
 */

export interface LiveRun {
  runId: string;
  messageId: string;
  model: string | null;
  reasoningEffort: string | null;
  continuing: boolean;
  content: readonly ContentBlock[];
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
 * the snapshot (in-flight message and last event id) and applies the rest.
 * EventSource reconnects on its own and sends Last-Event-ID.
 */
export function useSessionEvents(
  sessionId: string,
  detail: SessionDetail | undefined,
) {
  const queryClient = useQueryClient();
  const ready = detail !== undefined;

  useEffect(() => {
    if (!detail) return;
    const live = useLive.getState();
    const snapshot = detail.activeRun;
    live.set(sessionId, snapshot ?? undefined);

    const source = new EventSource(eventsUrl(sessionId, detail.lastEventId));
    // run.started carries the choices; message.started follows it.
    const runInfo = new Map<
      string,
      { model: string | null; reasoningEffort: string | null }
    >();
    source.onopen = () => useLive.getState().setConnected(sessionId, true);
    source.onerror = () => useLive.getState().setConnected(sessionId, false);
    source.onmessage = (msg: MessageEvent<string>) => {
      const event = JSON.parse(msg.data) as HarnessEvent;
      const state = useLive.getState();

      switch (event.type) {
        case "run.started":
          runInfo.set(event.runId, {
            model: event.data.model ?? null,
            reasoningEffort: event.data.reasoningEffort ?? null,
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
          state.set(sessionId, {
            runId: event.runId,
            messageId: event.data.messageId,
            model: runInfo.get(event.runId)?.model ?? null,
            reasoningEffort: runInfo.get(event.runId)?.reasoningEffort ?? null,
            continuing: event.data.continuing ?? false,
            content:
              event.data.continuing && existing?.message.role === "assistant"
                ? existing.message.content
                : [],
          });
          break;
        }
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
          void queryClient
            .invalidateQueries({ queryKey: ["session", sessionId] })
            .then(() => {
              const current = useLive.getState().runs[sessionId];
              if (current?.runId === event.runId)
                useLive.getState().set(sessionId, undefined);
            });
          break;
        default:
          state.update(sessionId, (run) => {
            const usage =
              (event.type === "text.delta" ||
                event.type === "reasoning.delta") &&
              event.data.usage
                ? event.data.usage
                : run.usage;
            return {
              ...run,
              content: applyMessageEvent(run.content, run.messageId, event),
              ...(usage ? { usage } : {}),
            };
          });
      }
    };

    return () => {
      source.close();
      useLive.getState().setConnected(sessionId, false);
    };
    // Connect once per session, after the first load; later refetches must
    // not reset the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ready]);
}
