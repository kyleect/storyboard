import { Badge, Group, RingProgress, Text, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { Usage } from "@harness/core";
import { api } from "../api";
import { modelKeys } from "../queries";

const WARN = 75;
const DANGER = 90;

const tokens = (n: number) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const used = (u: Usage) => u.promptTokens + u.completionTokens;

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

export function ContextMeter({
  usage,
  model,
  subagentUsage,
  compact = false,
}: {
  usage: Usage | undefined;
  model: string | undefined;
  subagentUsage?: Usage | null;
  compact?: boolean;
}) {
  const size = useQuery({
    queryKey: modelKeys.contextSize(model),
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
      {subagentUsage && (
        <>
          <br />
          Subagents (total, all calls): {tokens(used(subagentUsage))}
        </>
      )}
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
        <Text size={compact ? "xs" : "sm"} c="dimmed" aria-label="Context used">
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
          size={compact ? 18 : 36}
          thickness={compact ? 3 : 4}
          roundCaps
          sections={[{ value: Math.min(100, percent), color: color(percent) }]}
          {...(compact
            ? {}
            : {
                label: (
                  <Text size="9px" ta="center" fw={600}>
                    {Math.round(percent)}%
                  </Text>
                ),
              })}
        />
        <Text
          size={compact ? "xs" : "sm"}
          c="dimmed"
          style={{ whiteSpace: "nowrap" }}
        >
          {compact && `${Math.round(percent)}% · `}
          {tokens(total)} / {tokens(contextSize)} · {tokens(left)} left
        </Text>
      </Group>
    </Tooltip>
  );
}

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
