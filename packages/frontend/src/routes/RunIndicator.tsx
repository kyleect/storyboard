import {
  Anchor,
  Badge,
  Group,
  Loader,
  Popover,
  Stack,
  Text,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  useDebouncedFlag,
  type RunSummary,
  type SessionRunState,
} from "../runs";

/*
 * The activity indicators in the navbar: a spinner on each session that has a
 * run working, a badge where a run waits for the user, and one summary at the
 * top. Waiting shows at once, because the user is needed; the spinner is
 * debounced so short or back-to-back runs do not flicker.
 */

/** A spinner, or a still dot when the user prefers reduced motion. */
function Spinner({ label }: { label: string }) {
  const reduced = useReducedMotion();
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
        <Loader color="blue" type="dots" size="sm" />
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
    >
      !
    </Badge>
  );
}

/** What a session row shows: nothing, a spinner, or the waiting badge. */
export function SessionRunBadge({
  state,
}: {
  state: SessionRunState | undefined;
}) {
  // Either state keeps the spinner flag on, so waiting then working again
  // goes straight back to the spinner.
  const shown = useDebouncedFlag(state !== undefined);
  if (state === "waiting") return <WaitingBadge />;
  return shown ? <Loader color="blue" type="dots" size="xs" /> : null;
}

/** The summary at the top of the navbar; a popover lists the runs. */
export function GlobalRunIndicator({
  summary,
}: {
  summary: RunSummary | undefined;
}) {
  const workingNow = summary?.working ?? 0;
  const waiting = summary?.waiting ?? 0;
  const showWorking = useDebouncedFlag(workingNow > 0);

  // Keep the last count while the spinner lingers after the last run ends.
  const [lastWorking, setLastWorking] = useState(0);
  if (workingNow > 0 && workingNow !== lastWorking) setLastWorking(workingNow);

  if (!summary || (!showWorking && waiting === 0)) return null;

  const workingText = `${lastWorking} ${lastWorking === 1 ? "agent" : "agents"}`;

  return (
    <>
      <Popover width={280} position="bottom-start" shadow="md" withArrow>
        <Popover.Target>
          <UnstyledButton aria-label="Agent activity">
            <Group gap={6} wrap="nowrap">
              {showWorking && (
                <Group>
                  <Badge size="xs" radius="xs" variant="gradient">
                    {workingText}
                  </Badge>
                  <Spinner label="Agents are working" />
                </Group>
              )}
              {waiting > 0 && (
                <Group gap={4} wrap="nowrap">
                  <WaitingBadge />
                  <Text size="xs">{waiting} waiting</Text>
                </Group>
              )}
            </Group>
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
