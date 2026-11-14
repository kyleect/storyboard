import {
  Anchor,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import utils from "../styles/utilities.module.css";
import { modals } from "@mantine/modals";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type ErrorEntry, type ErrorFilter } from "../api";
import { errorKeys } from "../queries";
import { showError } from "../lib/notify";

export const KIND_LABELS: Record<ErrorEntry["kind"], string> = {
  tool_threw: "failed",
  tool_returned_error: "returned an error",
  unknown_tool: "unknown tool",
  invalid_arguments: "invalid arguments",
  malformed_call: "malformed call",
  run_failed: "run failed",
};
export const messageAnchor = (messageId: string) => `message-${messageId}`;
export function confirmClear(what: string, onConfirm: () => void) {
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
export function detailText(error: ErrorEntry): string | null {
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
export function ErrorItem({
  error,
  showSession,
  onShowInTranscript,
}: {
  error: ErrorEntry;
  showSession: boolean;
  onShowInTranscript?: ((messageId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const extra = detailText(error);
  const { messageId } = error;
  return (
    <Paper p="xs" data-testid="error-item">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          {new Date(error.createdAt).toLocaleString()}
        </Text>
        <Badge color="gray" tt="none">
          {error.toolName ?? "run"}
        </Badge>
        <Badge color="red" tt="none">
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
      <Text size="sm" mt={4} className={utils.preWrap}>
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
export function withoutKeys(
  f: ErrorFilter,
  keys: readonly (keyof ErrorFilter)[],
): ErrorFilter {
  return Object.fromEntries(
    Object.entries(f).filter(([k]) => !keys.includes(k as keyof ErrorFilter)),
  ) as ErrorFilter;
}
export function SessionErrorsPanel({
  sessionId,
  onShowInTranscript,
}: {
  sessionId: string;
  onShowInTranscript: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const errors = useQuery({
    queryKey: errorKeys.list({ sessionId }),
    queryFn: () => api.listErrors({ sessionId }),
  });
  const clear = useMutation({
    mutationFn: () => api.clearErrors(sessionId),
    onError: showError("Could not clear the errors"),
  });
  const count = errors.data?.length ?? 0;

  return (
    <Paper p={4}>
      <Group justify="space-between" wrap="nowrap">
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          px={4}
        >
          <Group gap={6}>
            <Text size="sm">{open ? "▾" : "▸"} Errors</Text>
            <Badge size="sm" color={count > 0 ? "red" : "gray"}>
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
