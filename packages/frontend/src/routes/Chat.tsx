import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Spoiler,
  Stack,
  SegmentedControl,
  Text,
  Textarea,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ASK_USER,
  DECLINED,
  mediaSupport,
  readAskUserCall,
  type ApprovalAnswer,
  type ContentBlock,
  type Form,
  type InputAnswer,
  type InputRequest,
  type Message,
  type PromptRecord,
  type Selection,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import {
  api,
  type Choices,
  type MessageAgent,
  type SessionDetail,
  type StoredMessage,
} from "../api";
import {
  modelKeys,
  projectKeys,
  sessionKeys,
  settingsKeys,
  toolKeys,
} from "../queries";
import {
  liveRuns,
  useLive,
  useSessionEvents,
  type LiveChild,
  type LiveRunState,
} from "../live";
import { AgentBadge, AgentPicker } from "./Agents";
import { ApprovalDialog } from "./ApprovalDialog";
import { AskUserForm, type AskUserState } from "./AskUserForm";
import {
  AttachButton,
  DraftAttachments,
  MessageFiles,
  SessionFilesContext,
  useAttachmentDraft,
} from "./Attachments";
import { VoiceButtons, type RecordingMode } from "./VoiceButtons";
import { latestUsage } from "./ContextMeter";
import { NotesPanel } from "./Entries";
import { FilesExplorer } from "./FilesExplorer";
import { useChatStatus } from "../chatStatus";
import { useReportDirty } from "../dirty";
import { useDraft, useDrafts } from "../drafts";
import { StructuredExplorer } from "./StructuredExplorer";
import { messageAnchor, SessionErrorsPanel } from "./Errors";
import {
  BranchSwitcher,
  Continuations,
  EditMessageBox,
  MessageActions,
  openForkDialog,
  useBranchActions,
} from "./Branching";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { AttachedWorkspaces } from "./Workspaces";
import { effortLabel, ReasoningPicker } from "./ReasoningPicker";
import { DebugPanel } from "./DebugPanel";
import { showError, useSessionActions } from "./SessionActions";
import { TranscriptScroll } from "./TranscriptScroll";

/**
 * What tool calls need to draw their forms: `ask_user`'s (input forms
 * design) and other tools' (tool prompts design).
 */
interface Asks {
  /** Tool results by call id. */
  results: ReadonlyMap<string, ToolResultMessage>;
  /** The forms waiting for an answer, in any of the session's runs. */
  opens: readonly OpenForm[];
  /** Forms answered, by call id, shown until the result is stored. */
  submitted: ReadonlyMap<string, Sent>;
  busy: boolean;
  onAnswer: (open: OpenForm, answer: InputAnswer) => void;
  /**
   * The work of the subagent each `start_subagent` call started, by call id
   * (agent delegation design, decision 42).
   */
  subagents: ReadonlyMap<string, SubagentView>;
  /** Sends a message to a running subagent (by its run id). */
  onSendToSubagent: (runId: string, text: string) => void;
  /** A message to a subagent is being sent. */
  sendingToSubagent: boolean;
  /** The anchor of a message to scroll to, so its subagent opens. */
  reveal?: string | null;
}

/** A form waiting for an answer, with the run that must receive it. */
interface OpenForm {
  request: InputRequest;
  runId: string;
}

/** A subagent's run under the call that started it. */
interface SubagentView {
  agentName: string;
  /** Its messages, the task first, with the one being written now. */
  messages: ShownMessage[];
  running: boolean;
  /** Its run id while it runs; the user can send it messages. */
  runId: string | null;
  /** Messages the user sent that it has not read yet, oldest first. */
  queued: readonly string[];
  /** It is waiting for the user: a form or an approval is open. */
  waiting: boolean;
}

/** A form the user answered, and the answers sent. */
interface Sent {
  form: Form;
  answers: Record<string, unknown>;
}

interface ShownMessage {
  id: string;
  message: Message;
  model: string | null;
  reasoningEffort: string | null;
  agent: MessageAgent | null;
  streaming: boolean;
  /** Running token count while streaming. */
  usage?: Usage | undefined;
  /** The messages that can start here, with this one's place among them. */
  branches?: StoredMessage["branches"] | undefined;
}

/** Tells the workbench's status bar about this chat, while it is shown. */
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
  const detail = useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: () => api.getSession(sessionId),
  });
  const settings = useQuery({
    queryKey: settingsKeys.all,
    queryFn: api.getSettings,
  });
  // Start the stream from a fresh load, not from cached data: a cached
  // snapshot's last event id can be older than events already handled, such
  // as session.trashed when a trashed session is opened from the trash.
  useSessionEvents(
    sessionId,
    detail.isFetchedAfterMount ? detail.data : undefined,
  );
  const live = useLive((s) => s.runs[sessionId]);
  // The session's runs in progress: the top-level one, then its subagents'.
  const runs = liveRuns(live);
  const connected = useLive((s) => s.connected[sessionId] ?? false);
  // The message being written; kept in a store so it survives a visit to
  // another tab (this chat is not mounted while another tab is active).
  const draft = useDraft(sessionId).text;
  const patchDraft = useDrafts((s) => s.patch);
  const setDraft = (text: string) =>
    patchDraft(sessionId, (d) => ({ ...d, text }));
  // Images and audio attached to the message being written.
  const files = useAttachmentDraft(sessionId);
  // The newest draft and files, for a send that waits for an upload.
  const composer = useRef({ draft, items: files.items });
  useEffect(() => {
    composer.current = { draft, items: files.items };
  });
  // What each model can read, to tell when an attachment cannot be used.
  const models = useQuery({
    queryKey: modelKeys.list(),
    queryFn: api.listModels,
  });
  // Chat, or the session's files, memory, data or debugging tools (plan U3).
  const [tab, setTab] = useState<string>("chat");
  // The Files view is made on the first visit and kept, hidden, after that,
  // so edits not yet saved survive a look at the chat.
  const [filesOpened, setFilesOpened] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  if (tab === "files" && !filesOpened) setFilesOpened(true);
  // Like Files, Structured Data stays mounted once opened, so unsaved edits
  // survive a visit to another tab.
  const [dataOpened, setDataOpened] = useState(false);
  const [dataDirty, setDataDirty] = useState(false);
  // The workbench keeps this tab mounted, and asks before closing it, while
  // Files or Structured Data hold edits not yet saved.
  useReportDirty(filesDirty || dataDirty);
  if (tab === "data" && !dataOpened) setDataOpened(true);

  // "Show in transcript" (error reporting plan, P7): scrolls to a message,
  // from the errors panel, or from the address (#message-<id>) when opened
  // from the errors page.
  const hash = useRouterState({ select: (s) => s.location.hash }).replace(
    /^#/,
    "",
  );
  const hashTarget = hash.startsWith(messageAnchor("")) ? hash : null;
  // The anchor to scroll to once it is shown, and the hash already handled.
  const pendingScroll = useRef<string | null>(null);
  // The message being shown from the errors panel, so the subagent that holds
  // it opens.
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
  // The message being edited, if any.
  const [editing, setEditing] = useState<string | null>(null);
  const choices: Choices = {
    ...(session?.model ? { model: session.model } : {}),
    ...(session?.reasoning_effort
      ? { reasoningEffort: session.reasoning_effort }
      : {}),
    // Sent every time, so "no agent" is sent too (agents design 11).
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
      // Shows the stored user message.
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(sessionId),
      });
      // Sending in a project's session counts as using the project.
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
      // "Always allow" changes the tool's setting.
      if (a.answer.choice === "always") {
        void queryClient.invalidateQueries({ queryKey: toolKeys.list() });
        void queryClient.invalidateQueries({
          queryKey: toolKeys.approvals(),
        });
      }
    },
    onError,
  });
  // Answers sent for each form, shown until its call's result is stored.
  const [submitted, setSubmitted] = useState<ReadonlyMap<string, Sent>>(
    new Map(),
  );
  // The message is shown as waiting at once, so the run reading it before the
  // answer arrives still finds it to remove.
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
  // The request whose dialog was closed without an answer.
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

  // Stored messages, with the in-flight ones replacing or following them.
  // A subagent's messages are grouped under the call that started it.
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
  // Approval notes, stored on tool results, are shown under their calls.
  const notes = new Map<string, NonNullable<ToolResultMessage["note"]>>();
  for (const m of detail.data.messages) {
    if (m.message.role === "tool" && m.message.note)
      notes.set(m.message.callId, m.message.note);
  }
  // A session in the trash can be read, not changed (design Q3a).
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
  // What waits for the user in any run: the oldest approval and form first,
  // each answered by the run that owns it (agent delegation design, 25, 26).
  const approvals = runs.flatMap((run) =>
    run.approvals.map((request) => ({ request, run })),
  );
  const opens: OpenForm[] = runs.flatMap((run) =>
    run.inputs.map((request) => ({ request, runId: run.runId })),
  );
  const pendingEntry = approvals[0];
  const pending = pendingEntry?.request;
  const openInput = opens[0]?.request;
  // Between model calls: a tool is running (a form shows it is waiting). A
  // run waiting for its subagent is not the one writing.
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
  // The model whose levels the reasoning picker shows.
  const levelsModel = detail.data.session.model || defaults?.model || undefined;
  // Whether the model in use reads images and audio: undefined when
  // llama-server does not say, and then attaching is allowed.
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
  // A finished recording is attached; from "Record & send" it is also sent,
  // with the text and files already in the composer. It is sent once it has
  // uploaded, using what the composer holds by then, so text typed while it
  // uploaded goes with it.
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
  // How full the context is: the running count while a call streams, else
  // the latest stored message's.
  const contextUsage =
    live?.usage ??
    latestUsage(detail.data.messages.filter((m) => !m.parentCallId));
  // Session files and notes cannot change in the trash or during a run
  // (plan P5).
  const entriesReadOnly = trashed
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
            { value: "memory", label: "Memory" },
            { value: "data", label: "Structured Data" },
            { value: "workspaces", label: "Workspaces" },
            { value: "debug", label: "Debug" },
          ]}
          style={{
            alignSelf: "flex-start",
            maxWidth: "100%",
            overflowX: "auto",
          }}
        />

        {filesOpened && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: tab === "files" ? "block" : "none",
            }}
          >
            <FilesExplorer
              key={sessionId}
              page={{ scope: "session", id: sessionId }}
              projectId={detail.data.session.project_id}
              readOnly={entriesReadOnly}
              projectReadOnly={
                detail.data.project?.trashed_at
                  ? "The project is in the trash, so its files can be read but not changed."
                  : undefined
              }
              onDirtyChange={setFilesDirty}
            />
          </div>
        )}

        {dataOpened && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: tab === "data" ? "block" : "none",
            }}
          >
            <StructuredExplorer
              key={sessionId}
              page={{ scope: "session", id: sessionId }}
              projectId={detail.data.session.project_id}
              readOnly={entriesReadOnly}
              projectReadOnly={
                detail.data.project?.trashed_at
                  ? "The project is in the trash, so its data can be read but not changed."
                  : undefined
              }
              onDirtyChange={setDataDirty}
            />
          </div>
        )}

        {tab !== "chat" && tab !== "files" && tab !== "data" && (
          <ScrollArea style={{ flex: 1 }}>
            {tab === "debug" ? (
              <DebugPanel sessionId={sessionId} />
            ) : tab === "workspaces" ? (
              <AttachedWorkspaces
                owner="sessions"
                id={sessionId}
                disabled={trashed}
              />
            ) : (
              <NotesPanel
                scope={{ scope: "session", id: sessionId }}
                readOnly={entriesReadOnly}
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
                    <MessageView {...m} notes={notes} asks={asks} />
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

        {/* Errors of a session in the trash are not shown (Q6). */}
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
            // Files dropped on the composer are attached.
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
                style={{ flex: 1 }}
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
                // A pasted screenshot or file is attached; pasted text is not.
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

/** Approval notes by call id. */
type Notes = ReadonlyMap<string, NonNullable<ToolResultMessage["note"]>>;

/** Exported for tests. */
export function MessageView({
  message,
  model,
  reasoningEffort,
  agent,
  streaming,
  usage,
  notes,
  asks,
  userLabel = "You",
}: ShownMessage & { notes: Notes; asks: Asks; userLabel?: string }) {
  if (message.role === "user") {
    return (
      <Paper p="sm" withBorder bg="var(--mantine-color-default-hover)">
        <Text size="xs" c="dimmed">
          {userLabel}
        </Text>
        {message.files && message.files.length > 0 && (
          <MessageFiles files={message.files} />
        )}
        {message.content !== "" && <Markdown>{message.content}</Markdown>}
      </Paper>
    );
  }
  if (message.role === "tool") {
    if (
      message.name === ASK_USER &&
      (!message.isError || message.content === DECLINED)
    ) {
      return <AskUserResult message={message} />;
    }
    return (
      <Paper p="sm" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Tool result
          </Text>
          <Badge size="xs" variant="light" color="gray" tt="none">
            {message.name}
          </Badge>
          {message.isError && (
            <Badge size="xs" variant="light" color="red">
              error
            </Badge>
          )}
        </Group>
        <Code block>{showResult(message.content)}</Code>
        {message.media && message.media.length > 0 && (
          <MessageFiles files={message.media.map((m) => m.ref)} />
        )}
      </Paper>
    );
  }
  if (message.role === "edit") {
    return (
      <Paper p="sm" withBorder bg="var(--mantine-color-default-hover)">
        <Text size="xs" c="dimmed">
          Your edit to this session's files or memory
        </Text>
        <Markdown size="sm">{message.content}</Markdown>
      </Paper>
    );
  }
  if (message.role !== "assistant") {
    return (
      <Paper p="sm" withBorder>
        <Text size="xs" c="dimmed">
          {message.role}
        </Text>
        <Text style={{ whiteSpace: "pre-wrap" }}>{message.content}</Text>
      </Paper>
    );
  }
  return (
    <Paper p="sm" withBorder>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Assistant
        </Text>
        {agent && <AgentBadge agent={agent} />}
        {model && (
          <Badge size="xs" variant="light" color="gray" tt="none">
            {model}
          </Badge>
        )}
        {reasoningEffort && (
          <Badge size="xs" variant="light" color="grape" tt="none">
            reasoning: {effortLabel(reasoningEffort)}
          </Badge>
        )}
        {streaming && <Loader size="xs" type="dots" />}
      </Group>
      <Stack gap="xs">
        {message.content.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            // Only the block being written right now shows a live preview.
            live={streaming && i === message.content.length - 1}
            usage={usage}
            notes={notes}
            asks={asks}
          />
        ))}
      </Stack>
    </Paper>
  );
}

function BlockView({
  block,
  live,
  usage,
  notes,
  asks,
}: {
  block: ContentBlock;
  live: boolean;
  usage: Usage | undefined;
  notes: Notes;
  asks: Asks;
}) {
  switch (block.type) {
    case "text":
      return <Markdown>{block.text}</Markdown>;
    case "reasoning":
      return live ? (
        <LiveReasoning text={block.text} usage={usage} />
      ) : (
        <Spoiler
          maxHeight={48}
          showLabel="Show reasoning"
          hideLabel="Hide reasoning"
        >
          <Text
            size="sm"
            c="dimmed"
            fs="italic"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {block.text}
          </Text>
        </Spoiler>
      );
    case "tool_call": {
      const form = block.name === ASK_USER && readAskUserCall(block.arguments);
      if (form) {
        const state = askState(block.callId, asks);
        return (
          <AskUserForm
            key={`${state.mode}:${"requestId" in state ? state.requestId : ""}`}
            form={form}
            state={state}
          />
        );
      }
      const note = notes.get(block.callId);
      return (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Tool call
          </Text>
          <Code block>
            {block.name}(
            {typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments, null, 2)}
            )
          </Code>
          {note && (
            <Paper p="xs" withBorder bg="var(--mantine-color-default-hover)">
              <Text size="xs" c="dimmed">
                Your note ({note.choice === "deny" ? "denied" : "allowed"})
              </Text>
              <Markdown size="sm">{note.text}</Markdown>
            </Paper>
          )}
          <ToolPrompt callId={block.callId} asks={asks} />
          <SubagentPanel callId={block.callId} notes={notes} asks={asks} />
        </Stack>
      );
    }
  }
}

/**
 * The work of the subagent a `start_subagent` call started, under the call:
 * collapsed, and open while the subagent waits for the user (agent
 * delegation design, decision 42). Its forms and approvals show inside it,
 * labelled with its agent.
 */
function SubagentPanel({
  callId,
  notes,
  asks,
}: {
  callId: string;
  notes: Notes;
  asks: Asks;
}) {
  const view = asks.subagents.get(callId);
  // Null until the user chooses; then what they chose.
  const [chosen, setChosen] = useState<boolean | null>(null);
  if (!view) return null;
  const holdsTarget =
    !!asks.reveal &&
    view.messages.some((m) => messageAnchor(m.id) === asks.reveal);
  const expanded = chosen ?? (view.waiting || holdsTarget);
  return (
    <Paper
      p="xs"
      withBorder
      data-subagent={callId}
      bg="var(--mantine-color-default-hover)"
    >
      <Group gap="xs" wrap="nowrap">
        <Badge size="xs" variant="light" color="teal">
          subagent
        </Badge>
        <Text size="sm" fw={500}>
          {view.agentName}
        </Text>
        {view.waiting ? (
          <Badge size="xs" variant="filled" color="yellow">
            waiting for you
          </Badge>
        ) : view.running ? (
          <Group gap={4} wrap="nowrap">
            <Loader size="xs" type="dots" />
            <Text size="xs" c="dimmed">
              working
            </Text>
          </Group>
        ) : (
          <Text size="xs" c="dimmed">
            done
          </Text>
        )}
        <UnstyledButton onClick={() => setChosen(!expanded)}>
          <Text size="xs" c="blue">
            {expanded ? "Hide its work" : "Show its work"}
          </Text>
        </UnstyledButton>
      </Group>
      {expanded && (
        <Stack
          gap="xs"
          mt="xs"
          pl="sm"
          style={{ borderLeft: "2px solid var(--mantine-color-teal-light)" }}
        >
          {view.messages.length === 0 && (
            <Text size="xs" c="dimmed">
              Starting…
            </Text>
          )}
          {view.messages.map((m, i) => (
            <div key={m.id} id={messageAnchor(m.id)}>
              <MessageView
                {...m}
                notes={notes}
                asks={asks}
                userLabel={subagentUserLabel(m.message, i)}
              />
            </div>
          ))}
          {view.queued.map((text, i) => (
            <Paper key={i} p="sm" withBorder style={{ borderStyle: "dashed" }}>
              <Text size="xs" c="dimmed">
                You, to the subagent: waiting for its next step
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {text}
              </Text>
            </Paper>
          ))}
          {view.running && view.runId && (
            <SubagentMessageBox
              runId={view.runId}
              agentName={view.agentName}
              asks={asks}
            />
          )}
        </Stack>
      )}
    </Paper>
  );
}

/**
 * The label over a user message in a subagent's panel: by where it came from
 * (`source`), or, for messages saved before that was recorded, by position.
 */
function subagentUserLabel(message: Message, index: number): string {
  if (message.role === "user") {
    if (message.source === "task") return "Task from the agent";
    if (message.source === "reminder") return "Reminder";
    if (message.source === "user") return "You, to the subagent";
  }
  return index === 0 ? "Task from the agent" : "Reminder";
}

/**
 * A box to send a message to a running subagent. It reads the message at the
 * start of its next step; the current step is not stopped.
 */
function SubagentMessageBox({
  runId,
  agentName,
  asks,
}: {
  runId: string;
  agentName: string;
  asks: Asks;
}) {
  const [draft, setDraft] = useState("");
  const send = () => {
    if (!draft.trim() || asks.sendingToSubagent) return;
    asks.onSendToSubagent(runId, draft);
    setDraft("");
  };
  return (
    <Group align="flex-end" gap="xs" wrap="nowrap">
      <Textarea
        style={{ flex: 1 }}
        size="xs"
        autosize
        minRows={1}
        maxRows={6}
        aria-label={`Message to ${agentName}`}
        placeholder={`Message to ${agentName}, read at its next step (Ctrl+Enter to send)`}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Button
        size="xs"
        onClick={send}
        disabled={asks.sendingToSubagent || !draft.trim()}
      >
        Send
      </Button>
    </Group>
  );
}

/**
 * The form another tool shows during its call, under the call (tool
 * prompts D8): open while the run waits, then the answers until the result
 * is stored, then the answer kept with the result (D9).
 */
function ToolPrompt({ callId, asks }: { callId: string; asks: Asks }) {
  const result = asks.results.get(callId);
  if (result?.prompt) return <PromptAnswer prompt={result.prompt} />;
  if (result) return null;
  const open = asks.opens.find((o) => o.request.callId === callId);
  if (open) {
    return (
      <AskUserForm
        key={`open:${open.request.requestId}`}
        form={open.request.form}
        state={{
          mode: "open",
          requestId: open.request.requestId,
          busy: asks.busy,
          onAnswer: (answer) => asks.onAnswer(open, answer),
        }}
      />
    );
  }
  const sent = asks.submitted.get(callId);
  if (sent) {
    return (
      <AskUserForm
        key="answered"
        form={sent.form}
        state={{ mode: "answered", answers: sent.answers }}
      />
    );
  }
  return null;
}

/** How the user answered a tool's form, kept with its result (D9). */
function PromptAnswer({ prompt }: { prompt: PromptRecord }) {
  return (
    <Paper p="xs" withBorder bg="var(--mantine-color-default-hover)">
      <Text size="xs" c="dimmed">
        {prompt.title ?? "Your answer"}
      </Text>
      {prompt.skipped !== undefined ? (
        <Text size="sm">{prompt.skipped}</Text>
      ) : (
        prompt.answers.map((a, i) => (
          <Text size="sm" key={i}>
            <Text span size="sm" c="dimmed">
              {a.question}:
            </Text>{" "}
            {a.answer}
          </Text>
        ))
      )}
    </Paper>
  );
}

/** Where an `ask_user` call's form stands. */
function askState(callId: string, asks: Asks): AskUserState {
  const result = asks.results.get(callId);
  if (result && !result.isError) {
    const answers =
      result.data &&
      typeof result.data === "object" &&
      !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {};
    return { mode: "answered", answers };
  }
  if (result?.content === DECLINED) return { mode: "skipped" };
  const sent = asks.submitted.get(callId);
  if (!result && sent) return { mode: "answered", answers: sent.answers };
  const open = asks.opens.find((o) => o.request.callId === callId);
  if (!result && open) {
    return {
      mode: "open",
      requestId: open.request.requestId,
      busy: asks.busy,
      onAnswer: (answer) => asks.onAnswer(open, answer),
    };
  }
  return { mode: "closed" };
}

/**
 * An `ask_user` result: the outcome, with the JSON the model received one
 * click away (D16). The answers themselves show in the form.
 */
function AskUserResult({ message }: { message: ToolResultMessage }) {
  return (
    <Paper p="sm" withBorder>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Tool result
        </Text>
        <Badge size="xs" variant="light" color="gray" tt="none">
          {message.name}
        </Badge>
        <Text size="sm">{message.isError ? "Skipped" : "Answered"}</Text>
      </Group>
      <Spoiler
        maxHeight={0}
        showLabel="Show what the model received"
        hideLabel="Hide"
      >
        <Code block>{showResult(message.content)}</Code>
      </Spoiler>
    </Paper>
  );
}

/**
 * Reasoning still being written: collapsed to its latest line and the
 * running token count, with the full text one click away.
 */
function LiveReasoning({
  text,
  usage,
}: {
  text: string;
  usage: Usage | undefined;
}) {
  const [open, setOpen] = useState(false);
  const latest =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return (
    <Stack gap={2}>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Reasoning…
          {usage ? ` ${usage.completionTokens} tokens` : ""}
        </Text>
        <UnstyledButton onClick={() => setOpen((o) => !o)}>
          <Text size="xs" c="blue">
            {open ? "Hide" : "Show all"}
          </Text>
        </UnstyledButton>
      </Group>
      {open ? (
        <Text
          size="sm"
          c="dimmed"
          fs="italic"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {text}
        </Text>
      ) : (
        <Text size="sm" c="dimmed" fs="italic" lineClamp={1}>
          {latest}
        </Text>
      )}
    </Stack>
  );
}

/** A result's text, indented when it is JSON. */
function showResult(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
