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
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { ContentBlock, Message } from "@harness/core";
import { api } from "../api";
import { useLive, useSessionEvents } from "../live";

interface ShownMessage {
  id: string;
  message: Message;
  streaming: boolean;
}

export function Chat() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const detail = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
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
  const send = useMutation({
    mutationFn: (content: string) => api.sendMessage(sessionId, content),
    onSuccess: () => {
      setDraft("");
      // Shows the stored user message.
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError,
  });
  const cont = useMutation({
    mutationFn: () => api.continueLast(sessionId),
    onError,
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onError,
  });

  if (detail.isPending) return <Loader />;
  if (detail.isError) return <Alert color="red">{detail.error.message}</Alert>;

  // Stored messages, with the in-flight one replacing or following them.
  const shown: ShownMessage[] = detail.data.messages.map((m) =>
    live && m.id === live.messageId
      ? {
          id: m.id,
          message: { role: "assistant", content: [...live.content] },
          streaming: true,
        }
      : { ...m, streaming: false },
  );
  if (live && !shown.some((m) => m.id === live.messageId)) {
    shown.push({
      id: live.messageId,
      message: { role: "assistant", content: [...live.content] },
      streaming: true,
    });
  }
  // A user message sent before its run's first event arrives.
  const busy = !!live || send.isPending || cont.isPending;
  const last = shown.at(-1);

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

      <Group gap="xs">
        {live ? (
          <Button
            color="red"
            variant="light"
            onClick={() => cancel.mutate(live.runId)}
            loading={cancel.isPending}
          >
            Cancel
          </Button>
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

function MessageView({ message, streaming }: ShownMessage) {
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
        {streaming && <Loader size="xs" type="dots" />}
      </Group>
      <Stack gap="xs">
        {message.content.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </Stack>
    </Paper>
  );
}

function BlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <Text style={{ whiteSpace: "pre-wrap" }}>{block.text}</Text>;
    case "reasoning":
      return (
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
