import { Badge, Group, RingProgress, Text, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { Usage } from "@harness/core";
import { api } from "../api";

/*
 * How full a session's context is (context usage design): the latest model
 * call's prompt plus output tokens, against one slot's context size from
 * llama-server's /props.
 */

/** From 75% the meter shows a warning color, from 90% a danger color. */
const WARN = 75;
const DANGER = 90;

const tokens = (n: number) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Tokens in the context after a model call. */
export const used = (u: Usage) => u.promptTokens + u.completionTokens;

/** The usage of the latest message that has one; undefined when none. */
export function latestUsage(
  messages: readonly { usage: Usage | null }[],
): Usage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage;
    if (u) return u;
  }
  return undefined;
}

function color(percent: number) {
  return percent >= DANGER ? "red" : percent >= WARN ? "yellow" : "blue";
}

/**
 * The chat header's ring: used / size, percent and tokens left, with the
 * prompt/output split on hover. When the size is unknown, the token count
 * only. Nothing before the first model call reports usage.
 */
export function ContextMeter({
  usage,
  model,
}: {
  usage: Usage | undefined;
  /** The model whose context size is read; undefined: the server's. */
  model: string | undefined;
}) {
  const size = useQuery({
    queryKey: ["context-size", model ?? null],
    queryFn: () => api.contextSize(model),
    retry: false,
  });
  if (!usage) return null;

  const total = used(usage);
  const contextSize =
    size.data && "contextSize" in size.data ? size.data.contextSize : undefined;
  const why = size.isError
    ? size.error.message
    : size.data && "unavailable" in size.data
      ? size.data.unavailable
      : undefined;

  const split = (
    <Text size="xs">
      Prompt: {tokens(usage.promptTokens)}
      <br />
      Output: {tokens(usage.completionTokens)}
      {why !== undefined && (
        <>
          <br />
          Context size unknown: {why}
        </>
      )}
    </Text>
  );

  if (contextSize === undefined) {
    return (
      <Tooltip label={split} multiline withArrow>
        <Text size="sm" c="dimmed" aria-label="Context used">
          {tokens(total)} tokens
        </Text>
      </Tooltip>
    );
  }

  const percent = (total / contextSize) * 100;
  const left = Math.max(0, contextSize - total);
  return (
    <Tooltip label={split} multiline withArrow>
      <Group gap={6} wrap="nowrap" aria-label="Context used">
        <RingProgress
          size={36}
          thickness={4}
          roundCaps
          sections={[{ value: Math.min(100, percent), color: color(percent) }]}
          label={
            <Text size="9px" ta="center" fw={600}>
              {Math.round(percent)}%
            </Text>
          }
        />
        <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {tokens(total)} / {tokens(contextSize)} · {tokens(left)} left
        </Text>
      </Group>
    </Tooltip>
  );
}

/** A session list's token count (no context size is read for lists). */
export function UsageBadge({ usage }: { usage: Usage | null }) {
  if (!usage) return null;
  const total = used(usage);
  return (
    <Badge
      size="xs"
      variant="light"
      color="gray"
      tt="none"
      title={`${tokens(total)} tokens in context`}
    >
      {compact.format(total)}
    </Badge>
  );
}
