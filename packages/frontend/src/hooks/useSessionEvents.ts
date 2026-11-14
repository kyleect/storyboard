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
    const answering = new Set<string>();
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
          void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
          void queryClient.invalidateQueries({ queryKey: trashKeys.all });
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void navigate({ to: "/" });
          break;
        case "session.files_changed":
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: fileKeys.inScope({ scope: "session", id: sessionId }),
          });
          break;
        case "session.data_changed":
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          void queryClient.invalidateQueries({ queryKey: dataKeys.all });
          break;
        case "session.transcript_changed":
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
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          break;
        case "session.renamed":
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
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(sessionId),
          });
          if (/^(schemas?|data)_/.test(event.data.name)) {
            void queryClient.invalidateQueries({ queryKey: dataKeys.all });
          }
          if (/^files_/.test(event.data.name)) {
            void queryClient.invalidateQueries({ queryKey: fileKeys.all });
          }
          if (event.data.isError) {
            void queryClient.invalidateQueries({
              queryKey: errorKeys.list({ sessionId }),
            });
          }
          break;
        case "user.message":
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
            void queryClient
              .invalidateQueries({ queryKey: sessionKeys.detail(sessionId) })
              .then(() =>
                useLive
                  .getState()
                  .removeChild(sessionId, event.runId as string),
              );
            break;
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ready]);
}
