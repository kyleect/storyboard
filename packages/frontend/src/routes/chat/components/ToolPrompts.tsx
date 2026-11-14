import type { Asks } from "../lib/transcript-types";
import { Badge, Code, Group, Paper, Spoiler, Text } from "@mantine/core";
import {
  DECLINED,
  type PromptRecord,
  type ToolResultMessage,
} from "@harness/core";
import {
  AskUserForm,
  type AskUserState,
} from "../../../components/AskUserForm";

export function ToolPrompt({ callId, asks }: { callId: string; asks: Asks }) {
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
export function PromptAnswer({ prompt }: { prompt: PromptRecord }) {
  return (
    <Paper p="xs" bg="var(--mantine-color-default-hover)">
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
export function askState(callId: string, asks: Asks): AskUserState {
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
export function AskUserResult({ message }: { message: ToolResultMessage }) {
  return (
    <Paper p="sm">
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Tool result
        </Text>
        <Badge color="gray" tt="none">
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
export function showResult(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
