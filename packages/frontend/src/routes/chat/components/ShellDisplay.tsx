import { Badge, Code, Group, Stack, Text } from "@mantine/core";
import { useToolOutput } from "../../../stores/tool-output";
import {
  outcomeText,
  type ShellCall,
  type ShellOutcome,
} from "../lib/shell-call";

/*
 * How a shell command is drawn: the command and its output as plain text, with
 * real line breaks (the generic display shows them as JSON, with escaped ones).
 */

/** The command, as the model wrote it, and where it runs. */
export function ShellCommand({
  call,
  where,
}: {
  call: ShellCall;
  /** The name of the workspace that holds the folder, when it is known. */
  where?: string | undefined;
}) {
  const folder = call.cwd === "" ? "no folder given" : call.cwd;

  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {where ? `Runs in ${folder} (workspace ${where})` : `Runs in ${folder}`}
      </Text>
      <Code block data-testid="shell-command">
        {call.command}
      </Code>
      {call.description && (
        <Text size="xs" c="dimmed">
          The model says: {call.description}
        </Text>
      )}
    </Stack>
  );
}

/** What the command has printed so far, while it runs. */
export function ShellLiveOutput({ callId }: { callId: string }) {
  const text = useToolOutput((s) => s.byCall[callId]);

  if (text === undefined) return null;

  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        Output so far
      </Text>
      <Code block data-testid="shell-live">
        {text}
      </Code>
    </Stack>
  );
}

/** How a command ended, with its output. */
export function ShellOutcomeView({ outcome }: { outcome: ShellOutcome }) {
  const failed = outcome.timedOut || outcome.exitCode !== 0;

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge color={failed ? "red" : "green"} variant="light" tt="none">
          {outcomeText(outcome)}
        </Badge>
      </Group>
      {outcome.output === "" ? (
        <Text size="xs" c="dimmed">
          No output.
        </Text>
      ) : (
        <Code block data-testid="shell-output">
          {outcome.output}
        </Code>
      )}
      {outcome.notice && (
        <Text size="xs" c="dimmed">
          {outcome.notice}
        </Text>
      )}
    </Stack>
  );
}
