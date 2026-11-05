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
  Tabs,
  Text,
  Textarea,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ASK_USER,
  DECLINED,
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
} from "../api";
import {
  liveRuns,
  useLive,
  useSessionEvents,
  type LiveChild,
  type LiveRunState,
} from "../live";
import { AgentBadge, AgentPicker } from "./Agents";
import { ApprovalDialog } from "./ApprovalDialog";
import { SchemasAndData } from "./Data";
import { AskUserForm, type AskUserState } from "./AskUserForm";
import { ContextMeter, latestUsage } from "./ContextMeter";
import { FilesPanel, NotesPanel } from "./Entries";
import { messageAnchor, SessionErrorsPanel } from "./Errors";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { EditableTitle } from "./EditableTitle";
import { effortLabel, ReasoningPicker } from "./ReasoningPicker";
import { CopyDebugButton, DebugPanel } from "./DebugPanel";
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
}

export function Chat() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const detail = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });
  const settings = useQuery({
    queryKey: ["settings"],
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
  const [draft, setDraft] = useState("");
  // Chat, or the session's files, memory, data or debugging tools (plan U3).
  const [tab, setTab] = useState<string>("chat");

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
  const choices: Choices = {
    ...(session?.model ? { model: session.model } : {}),
    ...(session?.reasoning_effort
      ? { reasoningEffort: session.reasoning_effort }
      : {}),
    // Sent every time, so "no agent" is sent too (agents design 11).
    ...(session ? { agentId: session.agent_id } : {}),
  };

  const setChoices = useMutation({
    mutationFn: (c: {
      model?: string | null;
      reasoningEffort?: string | null;
      agentId?: string | null;
    }) => api.setSessionChoices(sessionId, c),
    onSuccess: (updated) => {
      queryClient.setQueryData<SessionDetail>(["session", sessionId], (old) =>
        old ? { ...old, session: updated } : old,
      );
    },
    onError,
  });
  const send = useMutation({
    mutationFn: (content: string) =>
      api.sendMessage(sessionId, content, choices),
    onSuccess: () => {
      setDraft("");
      // Shows the stored user message.
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      // Sending in a project's session counts as using the project.
      if (session?.project_id)
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError,
  });
  const cont = useMutation({
    mutationFn: () => api.continueLast(sessionId, choices),
    onSuccess: () => {
      if (session?.project_id)
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
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
        void queryClient.invalidateQueries({ queryKey: ["tools"] });
        void queryClient.invalidateQueries({
          queryKey: ["agent-tool-approvals"],
        });
      }
    },
    onError,
  });
  // Answers sent for each form, shown until its call's result is stored.
  const [submitted, setSubmitted] = useState<ReadonlyMap<string, Sent>>(
    new Map(),
  );
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
    <Stack h="calc(100vh - 2 * var(--mantine-spacing-md))" gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <EditableTitle
          title={detail.data.session.title}
          disabled={trashed}
          label="Session title"
          onSave={(title) => actions.rename(sessionId, title)}
        />
        <Group gap="sm" wrap="nowrap">
          <CopyDebugButton sessionId={sessionId} />
          <ContextMeter
            usage={contextUsage}
            model={levelsModel}
            subagentUsage={detail.data.subagentUsage}
          />
          <Badge color={connected ? "green" : "gray"} variant="light">
            {connected ? "live" : "offline"}
          </Badge>
        </Group>
      </Group>

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

      <Tabs value={tab} onChange={(v) => v && setTab(v)}>
        <Tabs.List>
          <Tabs.Tab value="chat">Chat</Tabs.Tab>
          <Tabs.Tab value="files">Files</Tabs.Tab>
          <Tabs.Tab value="memory">Memory</Tabs.Tab>
          <Tabs.Tab value="data">Data</Tabs.Tab>
          <Tabs.Tab value="debug">Debug</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab !== "chat" && (
        <ScrollArea style={{ flex: 1 }}>
          {tab === "debug" ? (
            <DebugPanel sessionId={sessionId} />
          ) : tab === "data" ? (
            <SchemasAndData
              owner={{ scope: "session", id: sessionId }}
              readOnly={entriesReadOnly}
            />
          ) : tab === "files" ? (
            <FilesPanel
              scope={{ scope: "session", id: sessionId }}
              readOnly={entriesReadOnly}
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
                <MessageView {...m} notes={notes} asks={asks} />
              </div>
            ))}
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
            if (draft.trim() && !busy) send.mutate(draft);
          }}
        >
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
                  if (draft.trim() && !busy) send.mutate(draft);
                }
              }}
            />
            <Button type="submit" disabled={busy || !draft.trim()}>
              Send
            </Button>
          </Group>
        </form>
      )}
    </Stack>
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
        <Markdown>{message.content}</Markdown>
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
                userLabel={i === 0 ? "Task from the agent" : "Reminder"}
              />
            </div>
          ))}
        </Stack>
      )}
    </Paper>
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
