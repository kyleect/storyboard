import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  errorFiltersKey,
  errorsKey,
  type ErrorEntry,
  type ErrorFilter,
} from "../api";
import { showError } from "./SessionActions";

/*
 * The errors consoles (error reporting plan, P7): a page with every
 * session's errors, and a panel under each session's chat. Both update live
 * from `errors.changed` (live.ts).
 */

const KIND_LABELS: Record<ErrorEntry["kind"], string> = {
  tool_threw: "failed",
  tool_returned_error: "returned an error",
  unknown_tool: "unknown tool",
  invalid_arguments: "invalid arguments",
  malformed_call: "malformed call",
  run_failed: "run failed",
};

/** The anchor id of a message in the transcript, for "Show in transcript". */
export const messageAnchor = (messageId: string) => `message-${messageId}`;

/** Asks before clearing; `what` finishes "Clear …?". */
function confirmClear(what: string, onConfirm: () => void) {
  modals.openConfirmModal({
    title: `Clear ${what}?`,
    children: (
      <Text size="sm">
        The errors are deleted. The transcripts are not changed.
      </Text>
    ),
    labels: { confirm: "Clear", cancel: "Cancel" },
    confirmProps: { color: "red" },
    onConfirm,
  });
}

/** The extra detail kept for the console: details, arguments and stack. */
function detailText(error: ErrorEntry): string | null {
  const parts: string[] = [];
  if (error.details)
    parts.push(`Details:\n${JSON.stringify(error.details, null, 2)}`);
  if (error.arguments !== null)
    parts.push(
      `Arguments:\n${
        typeof error.arguments === "string"
          ? error.arguments
          : JSON.stringify(error.arguments, null, 2)
      }`,
    );
  if (error.stack) parts.push(`Stack:\n${error.stack}`);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function ErrorItem({
  error,
  showSession,
  onShowInTranscript,
}: {
  error: ErrorEntry;
  showSession: boolean;
  /** Left out: the link goes to the session's page. */
  onShowInTranscript?: ((messageId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const extra = detailText(error);
  const { messageId } = error;
  return (
    <Paper p="xs" withBorder data-testid="error-item">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          {new Date(error.createdAt).toLocaleString()}
        </Text>
        <Badge size="xs" variant="light" color="gray" tt="none">
          {error.toolName ?? "run"}
        </Badge>
        <Badge size="xs" variant="light" color="red" tt="none">
          {KIND_LABELS[error.kind]}
        </Badge>
        {showSession && (
          <Anchor
            size="xs"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/sessions/$sessionId"
                params={{ sessionId: error.sessionId }}
              />
            )}
          >
            {error.projectName
              ? `${error.projectName} / ${error.sessionTitle}`
              : error.sessionTitle}
          </Anchor>
        )}
        {messageId &&
          (onShowInTranscript ? (
            <Anchor
              size="xs"
              component="button"
              type="button"
              onClick={() => onShowInTranscript(messageId)}
            >
              Show in transcript
            </Anchor>
          ) : (
            <Anchor
              size="xs"
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/sessions/$sessionId"
                  params={{ sessionId: error.sessionId }}
                  hash={messageAnchor(messageId)}
                />
              )}
            >
              Show in transcript
            </Anchor>
          ))}
      </Group>
      <Text size="sm" mt={4} style={{ whiteSpace: "pre-wrap" }}>
        {error.message}
      </Text>
      {extra && (
        <>
          <Anchor
            size="xs"
            component="button"
            type="button"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide details" : "Show details"}
          </Anchor>
          <Collapse expanded={open}>
            <Code block mt={4}>
              {extra}
            </Code>
          </Collapse>
        </>
      )}
    </Paper>
  );
}

/** A list of errors, newest first. */
export function ErrorList({
  errors,
  showSession,
  onShowInTranscript,
}: {
  errors: ErrorEntry[];
  showSession: boolean;
  onShowInTranscript?: (messageId: string) => void;
}) {
  if (errors.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No errors.
      </Text>
    );
  return (
    <Stack gap="xs">
      {errors.map((e) => (
        <ErrorItem
          key={e.id}
          error={e}
          showSession={showSession}
          onShowInTranscript={onShowInTranscript}
        />
      ))}
    </Stack>
  );
}

/** A copy of a filter without some of its keys. */
function withoutKeys(
  f: ErrorFilter,
  keys: readonly (keyof ErrorFilter)[],
): ErrorFilter {
  return Object.fromEntries(
    Object.entries(f).filter(([k]) => !keys.includes(k as keyof ErrorFilter)),
  ) as ErrorFilter;
}

/** The tool/source filter's value for failed runs. */
const RUNS = "\u0000runs";
const NO_PROJECT = "none";

/** The global errors console (Q7). */
export function ErrorsPage() {
  const [filter, setFilter] = useState<ErrorFilter>({});
  const errors = useQuery({
    queryKey: errorsKey(filter),
    queryFn: () => api.listErrors(filter),
  });
  const options = useQuery({
    queryKey: errorFiltersKey,
    queryFn: api.errorFilters,
  });
  const clear = useMutation({
    mutationFn: () => api.clearErrors(),
    onError: showError("Could not clear the errors"),
  });

  /** Sets one filter; undefined removes it. */
  const set = (key: "sessionId" | "projectId", value: string | undefined) =>
    setFilter((f) => ({
      ...withoutKeys(f, [key]),
      ...(value ? { [key]: value } : {}),
    }));
  const toolValue = filter.source === "run" ? RUNS : (filter.tool ?? null);

  return (
    <Stack h="calc(100vh - 2 * var(--mantine-spacing-md))" gap="sm">
      <Group justify="space-between">
        <Title order={3}>Errors</Title>
        <Button
          color="red"
          variant="light"
          size="xs"
          disabled={!errors.data?.length}
          loading={clear.isPending}
          onClick={() =>
            confirmClear("every error", () => {
              clear.mutate();
            })
          }
        >
          Clear
        </Button>
      </Group>
      <Group gap="xs">
        <Select
          aria-label="Session"
          size="xs"
          clearable
          placeholder="Every session"
          data={(options.data?.sessions ?? []).map((s) => ({
            value: s.id,
            label: s.title,
          }))}
          value={filter.sessionId ?? null}
          onChange={(v) => set("sessionId", v ?? undefined)}
        />
        <Select
          aria-label="Project"
          size="xs"
          clearable
          placeholder="Every project"
          data={[
            { value: NO_PROJECT, label: "No project" },
            ...(options.data?.projects ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            })),
          ]}
          value={filter.projectId ?? null}
          onChange={(v) => set("projectId", v ?? undefined)}
        />
        <Select
          aria-label="Tool or source"
          size="xs"
          clearable
          placeholder="Every tool and run"
          data={[
            ...(options.data?.runs
              ? [{ value: RUNS, label: "Failed runs" }]
              : []),
            ...(options.data?.tools ?? []).map((t) => ({ value: t, label: t })),
          ]}
          value={toolValue}
          onChange={(v) =>
            setFilter((f) => {
              const rest = withoutKeys(f, ["source", "tool"]);
              if (v === null) return rest;
              return v === RUNS
                ? { ...rest, source: "run" }
                : { ...rest, source: "tool", tool: v };
            })
          }
        />
      </Group>
      {options.isError && (
        <Text c="red" size="xs">
          {options.error.message}
        </Text>
      )}
      <ScrollArea style={{ flex: 1 }}>
        {errors.isPending ? (
          <Loader />
        ) : errors.isError ? (
          <Alert color="red">{errors.error.message}</Alert>
        ) : (
          <ErrorList errors={errors.data} showSession />
        )}
      </ScrollArea>
    </Stack>
  );
}

/** The session's errors console, under the chat (Q8), collapsed at first. */
export function SessionErrorsPanel({
  sessionId,
  onShowInTranscript,
}: {
  sessionId: string;
  onShowInTranscript: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const errors = useQuery({
    queryKey: errorsKey({ sessionId }),
    queryFn: () => api.listErrors({ sessionId }),
  });
  const clear = useMutation({
    mutationFn: () => api.clearErrors(sessionId),
    onError: showError("Could not clear the errors"),
  });
  const count = errors.data?.length ?? 0;

  return (
    <Paper withBorder p={4}>
      <Group justify="space-between" wrap="nowrap">
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          px={4}
        >
          <Group gap={6}>
            <Text size="sm">{open ? "▾" : "▸"} Errors</Text>
            <Badge size="sm" variant="light" color={count > 0 ? "red" : "gray"}>
              {count}
            </Badge>
          </Group>
        </UnstyledButton>
        {open && count > 0 && (
          <Button
            size="compact-xs"
            color="red"
            variant="subtle"
            loading={clear.isPending}
            onClick={() =>
              confirmClear("this session's errors", () => {
                clear.mutate();
              })
            }
          >
            Clear
          </Button>
        )}
      </Group>
      <Collapse expanded={open}>
        <ScrollArea.Autosize mah={240} mt={4}>
          {errors.isError ? (
            <Text c="red" size="xs">
              {errors.error.message}
            </Text>
          ) : (
            <ErrorList
              errors={errors.data ?? []}
              showSession={false}
              onShowInTranscript={onShowInTranscript}
            />
          )}
        </ScrollArea.Autosize>
      </Collapse>
    </Paper>
  );
}
