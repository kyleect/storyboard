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
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { ContentBlock, Message, Usage } from "@harness/core";
import { api, type Choices, type SessionDetail } from "../api";
import { useLive, useSessionEvents } from "../live";
import { ModelPicker } from "./ModelPicker";
import { effortLabel, ReasoningPicker } from "./ReasoningPicker";

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
  useSessionEvents(sessionId, detail.data);
  const live = useLive((s) => s.runs[sessionId]);
  const connected = useLive((s) => s.connected[sessionId] ?? false);
  const [draft, setDraft] = useState("");

  const onError = (err: Error) =>
    notifications.show({
      color: "red",
      title: "Request failed",
      message: err.message,
    });
  const queryClient = useQueryClient();
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
    },
    onError,
  });
  const cont = useMutation({
    mutationFn: () => api.continueLast(sessionId, choices),
    onError,
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onError,
  });
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
  const liveShown: ShownMessage | undefined = live
    ? {
        id: live.messageId,
        message: { role: "assistant", content: [...live.content] },
        model: live.model,
        reasoningEffort: live.reasoningEffort,
        streaming: true,
        usage: live.usage,
      }
    : undefined;
  const shown: ShownMessage[] = detail.data.messages.map((m) =>
    liveShown && m.id === liveShown.id ? liveShown : { ...m, streaming: false },
  );
  if (liveShown && !shown.some((m) => m.id === liveShown.id)) {
    shown.push(liveShown);
  }
  const busy =
    !!live || send.isPending || cont.isPending || setChoices.isPending;
  const last = shown.at(-1);
  const reasoningNow = live?.content.at(-1)?.type === "reasoning";
  const defaults = settings.data?.effective;
  // The model whose levels the reasoning picker shows.
  const levelsModel = detail.data.session.model || defaults?.model || undefined;

  return (
    <Stack h="calc(100vh - 2 * var(--mantine-spacing-md))" gap="sm">
      <Group justify="space-between">
        <Title order={3}>{detail.data.session.title}</Title>
        <Badge color={connected ? "green" : "gray"} variant="light">
          {connected ? "live" : "offline"}
        </Badge>
      </Group>

      <ScrollArea style={{ flex: 1 }}>
        <Stack gap="sm" pr="md">
          {shown.length === 0 && <Text c="dimmed">No messages yet.</Text>}
          {shown.map((m) => (
            <MessageView key={m.id} {...m} />
          ))}
        </Stack>
      </ScrollArea>

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
            disabled={setChoices.isPending}
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
            disabled={setChoices.isPending}
          />
        </Group>
        {live ? (
          <Group gap="xs">
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
        <Code block>
          {block.name}({JSON.stringify(block.arguments, null, 2)})
        </Code>
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
