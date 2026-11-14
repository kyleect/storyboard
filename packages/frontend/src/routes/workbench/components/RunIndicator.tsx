import {
  Anchor,
  Badge,
  Loader,
  Popover,
  Stack,
  Text,
  UnstyledButton,
  useMantineTheme,
  VisuallyHidden,
} from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { RunSummary, SessionRunState } from "../../../hooks/useActiveRuns";
import { useDebouncedFlag } from "../../../hooks/useDebouncedFlag";
import { Led } from "@gfazioli/mantine-led";

/*
 * The activity indicators in the navbar: a spinner on each session that has a
 * run working, a badge where a run waits for the user, and one summary at the
 * top. Waiting shows at once, because the user is needed; the spinner is
 * debounced so short or back-to-back runs do not flicker.
 */

function Spinner({ label }: { label: string }) {
  const reduced = useReducedMotion();
  const theme = useMantineTheme();
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {reduced ? (
        <Text span size="xs">
          ●
        </Text>
      ) : (
        <Loader color={theme.primaryColor} type="dots" size="sm" />
      )}
    </span>
  );
}

function WaitingBadge() {
  return (
    <Badge
      size="xs"
      circle
      color="yellow"
      role="img"
      aria-label="Waiting for you"
      title="Waiting for you"
      style={{
        cursor: "pointer",
      }}
    >
      !
    </Badge>
  );
}

function UnreadDot({ label = "New reply" }: { label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      <Led color="green" size="xs" />
    </span>
  );
}

export function SessionRunBadge({
  state,
  unread,
}: {
  state: SessionRunState | undefined;
  unread?: boolean;
}) {
  const shown = useDebouncedFlag(state !== undefined);
  const theme = useMantineTheme();
  if (state === "waiting") return <WaitingBadge />;
  if (shown) return <Loader color={theme.primaryColor} type="dots" size="xs" />;
  // Show nothing, not the dot, or the dot would flash before the spinner.
  if (state !== undefined) return null;
  return unread ? <UnreadDot /> : null;
}

export function GlobalRunIndicator({
  summary,
}: {
  summary: RunSummary | undefined;
}) {
  const workingNow = summary?.working ?? 0;
  const waiting = summary?.waiting ?? 0;
  const showWorking = useDebouncedFlag(workingNow > 0);

  const [lastWorking, setLastWorking] = useState(0);
  if (workingNow > 0 && workingNow !== lastWorking) setLastWorking(workingNow);

  if (!summary || (!showWorking && waiting === 0)) return null;

  const workingText = `${lastWorking} ${lastWorking === 1 ? "agent" : "agents"}`;

  return (
    <>
      <Popover width={280} position="bottom-start" shadow="md" withArrow>
        <Popover.Target>
          <UnstyledButton aria-label="Agent activity">
            <Stack gap={6} p="xs" align="center" flex={1}>
              {showWorking && <Spinner label={workingText} />}
              {waiting > 0 && <WaitingBadge />}
            </Stack>
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            {summary.runs.map((run) => (
              <div key={run.runId}>
                <Anchor
                  size="sm"
                  renderRoot={(props) => (
                    <Link
                      {...props}
                      to="/sessions/$sessionId"
                      params={{ sessionId: run.sessionId }}
                    />
                  )}
                >
                  {run.sessionTitle || "Untitled session"}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {[
                    run.agentName ?? "No agent",
                    run.parentRunId !== null ? "subagent" : null,
                    run.waiting ? "waiting for you" : null,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </Text>
              </div>
            ))}
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <VisuallyHidden role="status" aria-live="polite">
        {[
          showWorking ? workingText : null,
          waiting > 0 ? `${waiting} waiting for you` : null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
      </VisuallyHidden>
    </>
  );
}

export function GlobalUnreadIndicator({
  count,
}: {
  count: number | undefined;
}) {
  const unread = count ?? 0;
  const shown = useDebouncedFlag(unread > 0);

  const [last, setLast] = useState(0);
  if (unread > 0 && unread !== last) setLast(unread);

  if (!shown) return null;
  const label =
    last === 1 ? "1 chat has a new reply" : `${last} chats have new replies`;
  return (
    <Stack p="xs" align="center">
      <UnreadDot label={label} />
    </Stack>
  );
}
