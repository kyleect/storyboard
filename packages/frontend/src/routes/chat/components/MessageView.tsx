import type { Asks, ShownMessage } from "../lib/transcript-types";
import {
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Spoiler,
  Stack,
  Text,
  Textarea,
  UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import {
  ASK_USER,
  DECLINED,
  readAskUserCall,
  type ContentBlock,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import { AskUserForm } from "../../../components/AskUserForm";
import { MessageFiles } from "./Attachments";
import { Markdown } from "../../../components/Markdown";
import { effortLabel } from "../../../components/ReasoningPicker";
import { LiveReasoning } from "./LiveReasoning";
import { AskUserResult, ToolPrompt, askState, showResult } from "./ToolPrompts";
import { useState } from "react";
import { AgentBadge } from "../../../components/AgentSelects";
import { messageAnchor } from "../../../components/ErrorList";

export type DecisionComments = ReadonlyMap<
  string,
  NonNullable<ToolResultMessage["decisionComment"]>
>;
export function MessageView({
  message,
  model,
  reasoningEffort,
  agent,
  streaming,
  usage,
  decisionComments,
  asks,
  userLabel = "You",
}: ShownMessage & {
  decisionComments: DecisionComments;
  asks: Asks;
  userLabel?: string;
}) {
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
          Your edit to this session's files
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
            live={streaming && i === message.content.length - 1}
            usage={usage}
            decisionComments={decisionComments}
            asks={asks}
          />
        ))}
      </Stack>
    </Paper>
  );
}
export function BlockView({
  block,
  live,
  usage,
  decisionComments,
  asks,
}: {
  block: ContentBlock;
  live: boolean;
  usage: Usage | undefined;
  decisionComments: DecisionComments;
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
      const decisionComment = decisionComments.get(block.callId);
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
          {decisionComment && (
            <Paper p="xs" withBorder bg="var(--mantine-color-default-hover)">
              <Text size="xs" c="dimmed">
                Your comment (
                {decisionComment.choice === "deny" ? "denied" : "allowed"})
              </Text>
              <Markdown size="sm">{decisionComment.text}</Markdown>
            </Paper>
          )}
          <ToolPrompt callId={block.callId} asks={asks} />
          <SubagentPanel
            callId={block.callId}
            decisionComments={decisionComments}
            asks={asks}
          />
        </Stack>
      );
    }
  }
}

export function SubagentPanel({
  callId,
  decisionComments,
  asks,
}: {
  callId: string;
  decisionComments: DecisionComments;
  asks: Asks;
}) {
  const theme = useMantineTheme();

  const view = asks.subagents.get(callId);
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
          <Text size="xs" c={theme.primaryColor}>
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
                decisionComments={decisionComments}
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
export function subagentUserLabel(message: Message, index: number): string {
  if (message.role === "user") {
    if (message.source === "task") return "Task from the agent";
    if (message.source === "reminder") return "Reminder";
    if (message.source === "user") return "You, to the subagent";
  }
  return index === 0 ? "Task from the agent" : "Reminder";
}
export function SubagentMessageBox({
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
