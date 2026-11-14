import {
  Alert,
  Button,
  Group,
  Loader,
  ScrollArea,
  Stack,
  SegmentedControl,
  Text,
  Textarea,
  Box,
} from "@mantine/core";
import { useSettings } from "../../hooks/useSettings";
import { useSession } from "../../hooks/useSessions";
import { useModels } from "../../hooks/useModels";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  mediaSupport,
  type ApprovalAnswer,
  type Form,
  type InputAnswer,
  type Selection,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import { api, type Choices, type SessionDetail } from "../../api";
import { projectKeys, sessionKeys, toolKeys } from "../../queries";
import { useSessionEvents } from "../../hooks/useSessionEvents";
import {
  liveRuns,
  useLive,
  type LiveChild,
  type LiveRunState,
} from "../../stores/live";
import { ApprovalDialog } from "./components/ApprovalDialog";
import {
  AttachButton,
  DraftAttachments,
  SessionFilesContext,
  useAttachmentDraft,
} from "./components/Attachments";
import { VoiceButtons, type RecordingMode } from "./components/VoiceButtons";
import { latestUsage } from "../../components/ContextMeter";
import { FilesExplorer } from "../../components/explorer/FilesExplorer";
import { useChatStatus } from "../../stores/chatStatus";
import { useReportDirty } from "../../stores/dirty";
import { useDraft, useDrafts } from "../../stores/drafts";
import { StructuredExplorer } from "../../components/structured/StructuredExplorer";
import {
  BranchSwitcher,
  Continuations,
  EditMessageBox,
  MessageActions,
  openForkDialog,
  useBranchActions,
} from "./components/Branching";
import { ModelPicker } from "../../components/ModelPicker";
import { effortLabel, ReasoningPicker } from "../../components/ReasoningPicker";
import { DebugPanel } from "./components/DebugPanel";
import { useSessionActions } from "../../hooks/useSessionActions";
import { TranscriptScroll } from "./components/TranscriptScroll";
import { showError } from "../../lib/notify";
import { MessageView } from "./components/MessageView";
import type {
  Asks,
  OpenForm,
  SubagentView,
  Sent,
  ShownMessage,
} from "./lib/transcript-types";
import { AgentPicker } from "../../components/AgentSelects";
import { messageAnchor, SessionErrorsPanel } from "../../components/ErrorList";
import { AttachedWorkspaces } from "../../components/AttachedWorkspaces";

function PublishStatus({
  sessionId,
  model,
  usage,
  subagentUsage,
  connected,
}: {
  sessionId: string;
  model: string | undefined;
  usage: Usage | undefined;
  subagentUsage: Usage | null;
  connected: boolean;
}) {
  const publish = useChatStatus((s) => s.publish);
  const clear = useChatStatus((s) => s.clear);

  useEffect(() => {
    publish({ sessionId, model, usage, subagentUsage, connected });
  }, [publish, sessionId, model, usage, subagentUsage, connected]);
  useEffect(() => () => clear(sessionId), [clear, sessionId]);

  return null;
}

export function Chat({ sessionId }: { sessionId: string }) {
  const detail = useSession(sessionId);
  const settings = useSettings();

  useSessionEvents(
    sessionId,
    detail.isFetchedAfterMount ? detail.data : undefined,
  );
  const live = useLive((s) => s.runs[sessionId]);
  const runs = liveRuns(live);
  const connected = useLive((s) => s.connected[sessionId] ?? false);
  const draft = useDraft(sessionId).text;
  const patchDraft = useDrafts((s) => s.patch);
  const setDraft = (text: string) =>
    patchDraft(sessionId, (d) => ({ ...d, text }));
  const files = useAttachmentDraft(sessionId);
  const composer = useRef({ draft, items: files.items });

  useEffect(() => {
    composer.current = { draft, items: files.items };
  });
  const models = useModels();
  const [tab, setTab] = useState<string>("chat");
  const [filesOpened, setFilesOpened] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);

  if (tab === "files" && !filesOpened) setFilesOpened(true);

  const [dataOpened, setDataOpened] = useState(false);
  const [dataDirty, setDataDirty] = useState(false);

  useReportDirty(filesDirty || dataDirty);

  if (tab === "data" && !dataOpened) setDataOpened(true);

  const hash = useRouterState({ select: (s) => s.location.hash }).replace(
    /^#/,
    "",
  );
  const hashTarget = hash.startsWith(messageAnchor("")) ? hash : null;
  const pendingScroll = useRef<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const handledHash = useRef<string | null>(null);
  const messageCount = detail.data?.messages.length ?? 0;

  useEffect(() => {
    if (hashTarget && handledHash.current !== hashTarget) {
      pendingScroll.current = hashTarget;
    }

    const target = pendingScroll.current;

    if (!target || tab !== "chat") return;

    const el = document.getElementById(target);

    if (!el) return;

    el.scrollIntoView({ block: "center" });
    pendingScroll.current = null;

    if (target === hashTarget) handledHash.current = hashTarget;
  }, [hashTarget, tab, messageCount, revealed]);
  const showInTranscript = (messageId: string) => {
    const target = messageAnchor(messageId);
    const el = tab === "chat" ? document.getElementById(target) : null;

    setRevealed(target);

    if (el) el.scrollIntoView({ block: "center" });
    else {
      pendingScroll.current = target;
      setTab("chat");
    }
  };

  const onError = (err: Error) =>
    notifications.show({
      color: "red",
      title: "Request failed",
      message: err.message,
    });
  const queryClient = useQueryClient();
  const actions = useSessionActions();
  const [restoring, setRestoring] = useState(false);
  const session = detail.data?.session;
  const [editing, setEditing] = useState<string | null>(null);
  const choices: Choices = {
    ...(session?.model ? { model: session.model } : {}),
    ...(session?.reasoning_effort
      ? { reasoningEffort: session.reasoning_effort }
      : {}),
    ...(session ? { agentId: session.agent_id } : {}),
  };
  const branch = useBranchActions(sessionId, choices);

  const setChoices = useMutation({
    mutationFn: (c: {
      model?: string | null;
      reasoningEffort?: string | null;
      agentId?: string | null;
    }) => api.setSessionChoices(sessionId, c),
    onSuccess: (updated) => {
      queryClient.setQueryData<SessionDetail>(
        sessionKeys.detail(sessionId),
        (old) => (old ? { ...old, session: updated } : old),
      );
    },
    onError,
  });
  const send = useMutation({
    mutationFn: (message: { content: string; files: string[] }) =>
      api.sendMessage(sessionId, message.content, choices, message.files),
    onSuccess: () => {
      setDraft("");
      files.clear();
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(sessionId),
      });

      if (session?.project_id)
        void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
    onError,
  });
  const cont = useMutation({
    mutationFn: () => api.continueLast(sessionId, choices),
    onSuccess: () => {
      if (session?.project_id)
        void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onError,
  });
  const answer = useMutation({
    mutationFn: (a: {
      runId: string;
      requestId: string;
      answer: ApprovalAnswer;
    }) => api.answerApproval(a.runId, a.requestId, a.answer),
    onSuccess: (_r, a) => {
      if (a.answer.choice === "always") {
        void queryClient.invalidateQueries({ queryKey: toolKeys.list() });
        void queryClient.invalidateQueries({
          queryKey: toolKeys.approvals(),
        });
      }
    },
    onError,
  });
  const [submitted, setSubmitted] = useState<ReadonlyMap<string, Sent>>(
    new Map(),
  );
  const sendToSubagent = useMutation({
    mutationFn: (a: { runId: string; text: string }) =>
      api.sendRunMessage(a.runId, a.text),
    onMutate: (a) =>
      useLive.getState().update(sessionId, a.runId, (run) => ({
        ...run,
        userMessages: [...run.userMessages, a.text],
      })),
    onError: (err: Error, a) => {
      useLive.getState().update(sessionId, a.runId, (run) => {
        const at = run.userMessages.lastIndexOf(a.text);

        return {
          ...run,
          userMessages: run.userMessages.filter((_, i) => i !== at),
        };
      });
      onError(err);
    },
  });
  const answerForm = useMutation({
    mutationFn: (a: {
      runId: string;
      requestId: string;
      callId: string;
      form: Form;
      answer: InputAnswer;
    }) => api.answerInput(a.runId, a.requestId, a.answer),
    onSuccess: (_r, a) => {
      const { answer } = a;

      if (answer.outcome === "answered")
        setSubmitted((m) =>
          new Map(m).set(a.callId, { form: a.form, answers: answer.answers }),
        );
    },
    onError,
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const stopThinking = useMutation({
    mutationFn: (runId: string) => api.endReasoning(runId),
    onSuccess: (result) => {
      if (!result.ok) {
        notifications.show({
          color: "yellow",
          title: "Could not stop the reasoning",
          message: result.message ?? "llama-server refused.",
        });
      }
    },
    onError,
  });

  if (detail.isPending) return <Loader />;

  if (detail.isError) return <Alert color="red">{detail.error.message}</Alert>;

  const inFlight = (run: LiveRunState): ShownMessage | undefined =>
    run.message
      ? {
          id: run.message.messageId,
          message: { role: "assistant", content: [...run.message.content] },
          model: run.model,
          reasoningEffort: run.reasoningEffort,
          agent: run.agent,
          streaming: true,
          usage: run.usage,
        }
      : undefined;
  const shown: ShownMessage[] = [];
  const nested = new Map<string, ShownMessage[]>();

  for (const m of detail.data.messages) {
    const item: ShownMessage = {
      id: m.id,
      message: m.message,
      model: m.model,
      reasoningEffort: m.reasoningEffort,
      agent: m.agent,
      streaming: false,
      branches: m.branches,
    };

    if (m.parentCallId) {
      nested.set(m.parentCallId, [...(nested.get(m.parentCallId) ?? []), item]);
    } else {
      shown.push(item);
    }
  }

  const place = (list: ShownMessage[], item: ShownMessage) => {
    const at = list.findIndex((m) => m.id === item.id);

    if (at === -1) list.push(item);
    else list[at] = item;
  };

  for (const run of runs) {
    const item = inFlight(run);

    if (!item) continue;

    const callId =
      "parentCallId" in run ? (run as LiveChild).parentCallId : null;

    if (callId === null) {
      place(shown, item);
    } else {
      const list = [...(nested.get(callId) ?? [])];

      place(list, item);
      nested.set(callId, list);
    }
  }

  const children = Object.values(live?.children ?? {});
  const subagents = new Map<string, SubagentView>();

  for (const callId of new Set([
    ...nested.keys(),
    ...children.map((c) => c.parentCallId),
  ])) {
    const messages = nested.get(callId) ?? [];
    const child = children.find((c) => c.parentCallId === callId);

    subagents.set(callId, {
      agentName:
        child?.agent?.name ??
        messages.find((m) => m.agent)?.agent?.name ??
        "subagent",
      messages,
      running: child !== undefined,
      runId: child?.runId ?? null,
      queued: child?.userMessages ?? [],
      waiting:
        child !== undefined &&
        (child.approvals.length > 0 || child.inputs.length > 0),
    });
  }

  const decisionComments = new Map<
    string,
    NonNullable<ToolResultMessage["decisionComment"]>
  >();

  for (const m of detail.data.messages) {
    if (m.message.role === "tool" && m.message.decisionComment)
      decisionComments.set(m.message.callId, m.message.decisionComment);
  }

  const trashed = detail.data.session.trashed_at !== null;
  const busy =
    trashed ||
    branch.pending ||
    !!live ||
    send.isPending ||
    cont.isPending ||
    setChoices.isPending;
  const last = shown.at(-1);
  const reasoningRun = runs.find(
    (r) => r.message?.content.at(-1)?.type === "reasoning",
  );
  const approvals = runs.flatMap((run) =>
    run.approvals.map((request) => ({ request, run })),
  );
  const opens: OpenForm[] = runs.flatMap((run) =>
    run.inputs.map((request) => ({ request, runId: run.runId })),
  );
  const pendingEntry = approvals[0];
  const pending = pendingEntry?.request;
  const openInput = opens[0]?.request;
  const toolRunning =
    !!live && !runs.some((r) => r.message) && !pending && !openInput;
  const asks: Asks = {
    results: new Map(
      detail.data.messages.flatMap((m) =>
        m.message.role === "tool" ? [[m.message.callId, m.message]] : [],
      ),
    ),
    opens,
    submitted,
    busy: answerForm.isPending,
    subagents,
    onSendToSubagent: (runId, text) =>
      sendToSubagent.mutate({ runId, text: text.trim() }),
    sendingToSubagent: sendToSubagent.isPending,
    reveal: hashTarget ?? revealed,
    onAnswer: (open, answer) =>
      answerForm.mutate({
        runId: open.runId,
        requestId: open.request.requestId,
        callId: open.request.callId,
        form: open.request.form,
        answer,
      }),
  };
  const defaults = settings.data?.effective;
  const levelsModel = detail.data.session.model || defaults?.model || undefined;
  const support = mediaSupport(
    levelsModel
      ? models.data?.find((m) => m.id === levelsModel)
      : models.data?.length === 1
        ? models.data[0]
        : undefined,
  );
  const unreadable = support
    ? [
        ...new Set(
          files.items.map((i) => i.kind).filter((kind) => !support[kind]),
        ),
      ]
    : [];
  const canSend =
    (draft.trim() !== "" || files.items.length > 0) &&
    !busy &&
    files.uploading === 0 &&
    unreadable.length === 0;
  const submit = () => {
    if (!canSend) return;

    send.mutate({
      content: draft.trim() === "" ? "" : draft,
      files: files.items.map((i) => i.ref),
    });
  };
  const recorded = async (file: File, mode: RecordingMode) => {
    const uploaded = await files.add([file]);

    if (mode !== "send" || uploaded.length === 0) return;

    if (busy || unreadable.length > 0) {
      notifications.show({
        color: "yellow",
        title: "Recording attached",
        message: busy
          ? "A run is in progress. Press Send when it ends."
          : "The model cannot read some of the attached files. Remove them, then press Send.",
      });

      return;
    }

    const latest = composer.current;

    send.mutate({
      content: latest.draft.trim() === "" ? "" : latest.draft,
      files: [
        ...new Set([
          ...latest.items.map((i) => i.ref),
          ...uploaded.map((a) => a.ref),
        ]),
      ],
    });
  };
  const contextUsage =
    live?.usage ??
    latestUsage(detail.data.messages.filter((m) => !m.parentCallId));
  const filesReadOnly = trashed
    ? "The session is in the trash, so these can be read but not changed."
    : live
      ? "A run is in progress; changes are possible when it ends."
      : undefined;

  return (
    <SessionFilesContext.Provider
      value={{ sessionId, projectId: detail.data.session.project_id }}
    >
      <Stack h="100%" gap="sm">
        <PublishStatus
          sessionId={sessionId}
          model={levelsModel}
          usage={contextUsage}
          subagentUsage={detail.data.subagentUsage}
          connected={connected}
        />
        {trashed && (
          <Alert color="yellow" title="This session is in the trash">
            <Group justify="space-between">
              <Text size="sm">It can be read but not changed.</Text>
              <Button
                size="xs"
                variant="light"
                loading={restoring}
                onClick={() => {
                  setRestoring(true);
                  const { project } = detail.data;

                  actions
                    .restore(
                      detail.data.session,
                      project?.trashed_at ? project : null,
                    )
                    .catch(showError("Could not restore"))
                    .finally(() => setRestoring(false));
                }}
              >
                Restore
              </Button>
            </Group>
          </Alert>
        )}

        <SegmentedControl
          size="xs"
          value={tab}
          onChange={setTab}
          aria-label="Session view"
          data={[
            { value: "chat", label: "Chat" },
            { value: "files", label: "Files" },
            { value: "data", label: "Structured Data" },
            { value: "workspaces", label: "Workspaces" },
            { value: "debug", label: "Debug" },
          ]}
          maw="100%"
          style={{ alignSelf: "flex-start", overflowX: "auto" }}
        />

        {filesOpened && (
          <Box flex={1} mih={0} display={tab === "files" ? "block" : "none"}>
            <FilesExplorer
              key={sessionId}
              page={{ scope: "session", id: sessionId }}
              projectId={detail.data.session.project_id}
              readOnly={filesReadOnly}
              projectReadOnly={
                detail.data.project?.trashed_at
                  ? "The project is in the trash, so its files can be read but not changed."
                  : undefined
              }
              onDirtyChange={setFilesDirty}
            />
          </Box>
        )}

        {dataOpened && (
          <Box flex={1} mih={0} display={tab === "data" ? "block" : "none"}>
            <StructuredExplorer
              key={sessionId}
              page={{ scope: "session", id: sessionId }}
              projectId={detail.data.session.project_id}
              readOnly={filesReadOnly}
              projectReadOnly={
                detail.data.project?.trashed_at
                  ? "The project is in the trash, so its data can be read but not changed."
                  : undefined
              }
              onDirtyChange={setDataDirty}
            />
          </Box>
        )}

        {tab !== "chat" && tab !== "files" && tab !== "data" && (
          <ScrollArea flex={1}>
            {tab === "debug" ? (
              <DebugPanel sessionId={sessionId} />
            ) : (
              <AttachedWorkspaces
                owner="sessions"
                id={sessionId}
                disabled={trashed}
              />
            )}
          </ScrollArea>
        )}

        {tab === "chat" && (
          <TranscriptScroll>
            <Stack gap="sm" pr="md">
              {shown.length === 0 && <Text c="dimmed">No messages yet.</Text>}
              {shown.map((m) => (
                <div key={m.id} id={messageAnchor(m.id)}>
                  {m.branches && (
                    <BranchSwitcher
                      branches={m.branches}
                      disabled={busy}
                      onSwitch={(id) => branch.switchTo.mutate(id)}
                      onDelete={(id) => branch.deleteBranch.mutate(id)}
                    />
                  )}
                  {editing === m.id && m.message.role === "user" ? (
                    <EditMessageBox
                      initial={m.message.content}
                      hasFiles={(m.message.files?.length ?? 0) > 0}
                      defaultMode={
                        settings.data?.effective.editMode ?? "branch"
                      }
                      saving={branch.edit.isPending}
                      onSave={(content, mode) =>
                        branch.edit.mutate(
                          { messageId: m.id, content, mode },
                          { onSuccess: () => setEditing(null) },
                        )
                      }
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <MessageView
                      {...m}
                      decisionComments={decisionComments}
                      asks={asks}
                    />
                  )}
                  {!busy && !m.streaming && editing === null && (
                    <MessageActions
                      messageId={m.id}
                      branching={detail.data.branching}
                      last={m.id === last?.id}
                      onEdit={() => setEditing(m.id)}
                      onBranchOff={() => branch.branchOff.mutate(m.id)}
                      onFork={() =>
                        openForkDialog(detail.data.session.title, (title) =>
                          branch.fork.mutate({ messageId: m.id, title }),
                        )
                      }
                      onRegenerate={() => branch.regenerate.mutate()}
                    />
                  )}
                </div>
              ))}
              {!busy && editing === null && (
                <Continuations
                  items={detail.data.branching.continuations}
                  disabled={busy}
                  onSwitch={(id) => branch.switchTo.mutate(id)}
                />
              )}
              {toolRunning && (
                <Group gap="xs">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    Running a tool…
                  </Text>
                </Group>
              )}
            </Stack>
          </TranscriptScroll>
        )}

        {tab === "chat" && !trashed && (
          <SessionErrorsPanel
            sessionId={sessionId}
            onShowInTranscript={showInTranscript}
          />
        )}

        {tab === "chat" && (
          <Group gap="xs" justify="space-between" align="flex-start">
            <Group gap="xs" align="flex-start">
              <ModelPicker
                value={detail.data.session.model}
                onChange={(model) => setChoices.mutate({ model })}
                loadOnSelect
                defaultModel={defaults?.model || undefined}
                placeholder={
                  defaults?.model
                    ? `Default (${defaults.model})`
                    : "Default (none set; the server decides)"
                }
                disabled={trashed || setChoices.isPending}
              />
              <ReasoningPicker
                model={levelsModel}
                value={detail.data.session.reasoning_effort}
                onChange={(reasoningEffort) =>
                  setChoices.mutate({ reasoningEffort })
                }
                placeholder={
                  defaults?.reasoningEffort
                    ? `Reasoning: default (${effortLabel(defaults.reasoningEffort)})`
                    : "Reasoning: default (server decides)"
                }
                disabled={trashed || setChoices.isPending}
              />
              <AgentPicker
                sessionId={sessionId}
                value={detail.data.session.agent_id}
                onChange={(agentId) => setChoices.mutate({ agentId })}
                disabled={trashed || setChoices.isPending}
              />
            </Group>
            {live ? (
              <Group gap="xs">
                {openInput && (
                  <Button
                    variant="light"
                    onClick={() =>
                      document
                        .querySelector(
                          `[data-request-id="${CSS.escape(openInput.requestId)}"]`,
                        )
                        ?.scrollIntoView({ block: "nearest" })
                    }
                  >
                    Answer needed
                  </Button>
                )}
                {pending && dismissed === pending.requestId && (
                  <Button variant="light" onClick={() => setDismissed(null)}>
                    Approval needed
                  </Button>
                )}
                {reasoningRun && (
                  <Button
                    variant="light"
                    onClick={() => stopThinking.mutate(reasoningRun.runId)}
                    loading={stopThinking.isPending}
                  >
                    Stop thinking
                  </Button>
                )}
                <Button
                  color="red"
                  variant="light"
                  onClick={() => cancel.mutate(live.runId)}
                  loading={cancel.isPending}
                >
                  Cancel
                </Button>
              </Group>
            ) : (
              <Button
                variant="light"
                disabled={busy || last?.message.role !== "assistant"}
                onClick={() => cont.mutate()}
              >
                Continue
              </Button>
            )}
          </Group>
        )}

        {pendingEntry && pending && (
          <ApprovalDialog
            key={pending.requestId}
            request={pending}
            {...(pendingEntry.run.runId !== live?.runId
              ? { from: pendingEntry.run.agent?.name ?? "a subagent" }
              : {})}
            opened={dismissed !== pending.requestId}
            busy={answer.isPending}
            onClose={() => setDismissed(pending.requestId)}
            onAnswer={(a) =>
              answer.mutate({
                runId: pendingEntry.run.runId,
                requestId: pending.requestId,
                answer: a,
              })
            }
            {...(pending.review
              ? {
                  onCheck: (selection: Selection) =>
                    api.checkApproval(
                      pendingEntry.run.runId,
                      pending.requestId,
                      selection,
                    ),
                  onRefresh: () =>
                    api.refreshApproval(
                      pendingEntry.run.runId,
                      pending.requestId,
                    ),
                }
              : {})}
          />
        )}

        {tab === "chat" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onDragOver={(e) => {
              if (!trashed && e.dataTransfer.types.includes("Files"))
                e.preventDefault();
            }}
            onDrop={(e) => {
              if (trashed || e.dataTransfer.files.length === 0) return;

              e.preventDefault();
              void files.add(Array.from(e.dataTransfer.files));
            }}
          >
            <DraftAttachments
              items={files.items}
              uploading={files.uploading}
              onRemove={files.remove}
            />
            {unreadable.length > 0 && (
              <Alert color="yellow" mb="xs" p="xs">
                The model in use cannot read {unreadable.join(" or ")} files.
                Remove them or pick another model.
              </Alert>
            )}
            <Group align="flex-end" gap="xs">
              <Textarea
                flex={1}
                autosize
                minRows={2}
                maxRows={8}
                placeholder="Write a message (Ctrl+Enter to send)"
                disabled={trashed}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                onPaste={(e) => {
                  const pasted = Array.from(e.clipboardData.files);

                  if (pasted.length === 0) return;

                  if (e.clipboardData.getData("text") !== "") return;

                  e.preventDefault();
                  void files.add(pasted);
                }}
              />
              <AttachButton
                onFiles={(picked) => void files.add(picked)}
                disabled={trashed}
              />
              <VoiceButtons
                onRecorded={(file, mode) => void recorded(file, mode)}
                disabled={trashed || support?.audio === false}
                sendDisabled={busy}
                {...(support?.audio === false
                  ? { title: "The model in use cannot hear audio." }
                  : {})}
              />
              <Button type="submit" disabled={!canSend}>
                Send
              </Button>
            </Group>
          </form>
        )}
      </Stack>
    </SessionFilesContext.Provider>
  );
}
