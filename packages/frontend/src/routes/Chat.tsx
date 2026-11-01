import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
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
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import type {
  ApprovalChoice,
  ApprovalRequest,
  ContentBlock,
  Message,
  Usage,
} from "@harness/core";
import { api, type Choices, type SessionDetail } from "../api";
import { useLive, useSessionEvents } from "../live";
import { ContextMeter, latestUsage } from "./ContextMeter";
import { FilesPanel, NotesPanel } from "./Entries";
import { ModelPicker } from "./ModelPicker";
import { EditableTitle } from "./EditableTitle";
import { effortLabel, ReasoningPicker } from "./ReasoningPicker";
import { showError, useSessionActions } from "./SessionActions";

interface ShownMessage {
  id: string;
  message: Message;
  model: string | null;
  reasoningEffort: string | null;
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
  const connected = useLive((s) => s.connected[sessionId] ?? false);
  const [draft, setDraft] = useState("");
  // Chat, or the session's files or memory (plan U3).
  const [tab, setTab] = useState<string>("chat");

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
  };

  const setChoices = useMutation({
    mutationFn: (c: {
      model?: string | null;
      reasoningEffort?: string | null;
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
      choice: ApprovalChoice;
    }) => api.answerApproval(a.runId, a.requestId, a.choice),
    onSuccess: (_r, a) => {
      // "Always allow" changes the tool's setting.
      if (a.choice === "always")
        void queryClient.invalidateQueries({ queryKey: ["tools"] });
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

  // Stored messages, with the in-flight one replacing or following them.
  const liveShown: ShownMessage | undefined = live?.message
    ? {
        id: live.message.messageId,
        message: { role: "assistant", content: [...live.message.content] },
        model: live.model,
        reasoningEffort: live.reasoningEffort,
        streaming: true,
        usage: live.usage,
      }
    : undefined;
  const shown: ShownMessage[] = detail.data.messages.map((m) =>
    liveShown && m.id === liveShown.id
      ? liveShown
      : {
          id: m.id,
          message: m.message,
          model: m.model,
          reasoningEffort: m.reasoningEffort,
          streaming: false,
        },
  );
  if (liveShown && !shown.some((m) => m.id === liveShown.id)) {
    shown.push(liveShown);
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
  const reasoningNow = live?.message?.content.at(-1)?.type === "reasoning";
  const pending = live?.approvals[0];
  // Between model calls: a tool is running.
  const toolRunning = !!live && !live.message && !pending;
  const defaults = settings.data?.effective;
  // The model whose levels the reasoning picker shows.
  const levelsModel = detail.data.session.model || defaults?.model || undefined;
  // How full the context is: the running count while a call streams, else
  // the latest stored message's.
  const contextUsage = live?.usage ?? latestUsage(detail.data.messages);
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
          <ContextMeter usage={contextUsage} model={levelsModel} />
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
        </Tabs.List>
      </Tabs>

      {tab !== "chat" && (
        <ScrollArea style={{ flex: 1 }}>
          {tab === "files" ? (
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
        <ScrollArea style={{ flex: 1 }}>
          <Stack gap="sm" pr="md">
            {shown.length === 0 && <Text c="dimmed">No messages yet.</Text>}
            {shown.map((m) => (
              <MessageView key={m.id} {...m} />
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
        </ScrollArea>
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
          </Group>
          {live ? (
            <Group gap="xs">
              {pending && dismissed === pending.requestId && (
                <Button variant="light" onClick={() => setDismissed(null)}>
                  Approval needed
                </Button>
              )}
              {reasoningNow && (
                <Button
                  variant="light"
                  onClick={() => stopThinking.mutate(live.runId)}
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

      {live && pending && (
        <ApprovalDialog
          request={pending}
          opened={dismissed !== pending.requestId}
          busy={answer.isPending}
          onClose={() => setDismissed(pending.requestId)}
          onAnswer={(choice) =>
            answer.mutate({
              runId: live.runId,
              requestId: pending.requestId,
              choice,
            })
          }
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

function MessageView({
  message,
  model,
  reasoningEffort,
  streaming,
  usage,
}: ShownMessage) {
  if (message.role === "user") {
    return (
      <Paper p="sm" withBorder bg="var(--mantine-color-default-hover)">
        <Text size="xs" c="dimmed">
          You
        </Text>
        <Text style={{ whiteSpace: "pre-wrap" }}>{message.content}</Text>
      </Paper>
    );
  }
  if (message.role === "tool") {
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
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {message.content}
        </Text>
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
}: {
  block: ContentBlock;
  live: boolean;
  usage: Usage | undefined;
}) {
  switch (block.type) {
    case "text":
      return <Text style={{ whiteSpace: "pre-wrap" }}>{block.text}</Text>;
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
    case "tool_call":
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
        </Stack>
      );
  }
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

const CHOICES: { choice: ApprovalChoice; label: string; color?: string }[] = [
  { choice: "once", label: "Allow once" },
  { choice: "session", label: "Allow for this session" },
  { choice: "always", label: "Always allow this tool" },
  { choice: "deny", label: "Deny", color: "red" },
];

/**
 * Asks whether a tool call may run (tools design 6.5). Closing it leaves the
 * request open; the run keeps waiting until it is answered.
 */
function ApprovalDialog({
  request,
  opened,
  busy,
  onClose,
  onAnswer,
}: {
  request: ApprovalRequest;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (choice: ApprovalChoice) => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Allow this tool call?"
      size="lg"
    >
      <Stack gap="sm">
        <Text size="sm">
          The model wants to run <Code>{request.name}</Code> with:
        </Text>
        <Code block>{JSON.stringify(request.arguments, null, 2)}</Code>
        <Group gap="xs" justify="flex-end">
          {CHOICES.map((c) => (
            <Button
              key={c.choice}
              variant={c.choice === "once" ? "filled" : "light"}
              {...(c.color ? { color: c.color } : {})}
              disabled={busy}
              onClick={() => onAnswer(c.choice)}
            >
              {c.label}
            </Button>
          ))}
        </Group>
      </Stack>
    </Modal>
  );
}
