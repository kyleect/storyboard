import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import { applyMessageEvent, type HarnessEvent } from "@harness/core";
import { eventsUrl, type SessionDetail, type StoredMessage } from "../api";
import { connectEventStream } from "../lib/event-stream";
import {
  dataKeys,
  errorKeys,
  fileKeys,
  modelKeys,
  sessionKeys,
  trashKeys,
} from "../queries";
import { findLiveRun, useLive } from "../stores/live";

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
        case "session.files_changed":
          // An edit to session-scoped files added a message.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: fileKeys.inScope({ scope: "session", id: sessionId }),
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
          // files, data and subagents follow the line shown.
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: fileKeys.inScope({ scope: "session", id: sessionId }),
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
          // The session's Files tab updates live (decision 35).
          // The Files view also shows the project's and the global files, so
          // a files tool can have changed any of them.
          if (/^files_/.test(event.data.name)) {
            void queryClient.invalidateQueries({ queryKey: fileKeys.all });
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

    const disconnect = connectEventStream({
      url: () => eventsUrl(sessionId, lastId),
      onOpen: () => useLive.getState().setConnected(sessionId, true),
      onError: () => useLive.getState().setConnected(sessionId, false),
      onMessage,
    });

    return () => {
      disconnect();
      useLive.getState().setConnected(sessionId, false);
    };
    // Connect once per session, after the first load; later refetches must
    // not reset the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ready]);
}
