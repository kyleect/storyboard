import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  type Branching,
  type Choices,
  type SessionDetail,
  type StoredMessage,
} from "../api";
import { sessionKeys } from "../queries";

/*
 * Editing and branching in the transcript (message editing plan, part B):
 * the action row under a message, the box an edit is written in, the "2/3"
 * control on a message that has siblings, and the row under the end of the
 * line that lists what else continues from it. Every action works only when
 * the session is idle; the page does not show them otherwise.
 */

/** The requests behind the controls; each refreshes the session after. */
export function useBranchActions(sessionId: string, choices: Choices) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.detail(sessionId),
    });
    void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
  };
  const onError = (err: Error) =>
    notifications.show({
      color: "red",
      title: "Request failed",
      message: err.message,
    });
  const options = { onSuccess: refresh, onError };

  const edit = useMutation({
    mutationFn: (a: {
      messageId: string;
      content: string;
      mode: "branch" | "in_place" | undefined;
    }) => api.editMessage(sessionId, a.messageId, a.content, a.mode, choices),
    ...options,
  });
  const regenerate = useMutation({
    mutationFn: () => api.regenerate(sessionId, choices),
    ...options,
  });
  const branchOff = useMutation({
    mutationFn: (messageId: string) =>
      api.branchOff(sessionId, messageId, choices),
    ...options,
  });
  const switchTo = useMutation({
    mutationFn: (messageId: string) => api.switchBranch(sessionId, messageId),
    ...options,
  });
  const deleteBranch = useMutation({
    mutationFn: (messageId: string) => api.deleteBranch(sessionId, messageId),
    ...options,
  });
  // A fork is a new session: open it.
  const fork = useMutation({
    mutationFn: (a: { messageId: string; title: string }) =>
      api.forkSession(sessionId, a.messageId, a.title),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: session.id },
      });
    },
    onError,
  });
  return {
    fork,
    edit,
    regenerate,
    branchOff,
    switchTo,
    deleteBranch,
    pending:
      edit.isPending ||
      regenerate.isPending ||
      branchOff.isPending ||
      switchTo.isPending ||
      deleteBranch.isPending ||
      fork.isPending,
  };
}

/** What is offered under one message. */
export interface MessageActionsProps {
  messageId: string;
  branching: Branching;
  /** Whether the message is the last of the line. */
  last: boolean;
  onEdit: () => void;
  onBranchOff: () => void;
  onFork: () => void;
  onRegenerate: () => void;
}

/**
 * Edit (the user's own messages), Branch off (where a request ending there
 * is valid) and Regenerate (the last reply). Nothing when none applies.
 */
export function MessageActions({
  messageId,
  branching,
  last,
  onEdit,
  onBranchOff,
  onFork,
  onRegenerate,
}: MessageActionsProps) {
  const canEdit = branching.editable.includes(messageId);
  const canBranch = branching.points.includes(messageId);
  const canRegenerate = last && branching.regenerate !== null;
  if (!canEdit && !canBranch && !canRegenerate) return null;
  return (
    <Group gap={2} mt={2}>
      {canEdit && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={onEdit}
        >
          Edit
        </Button>
      )}
      {canBranch && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={onBranchOff}
        >
          Branch off
        </Button>
      )}
      {canBranch && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={onFork}
        >
          Fork
        </Button>
      )}
      {canRegenerate && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={onRegenerate}
        >
          Regenerate
        </Button>
      )}
    </Group>
  );
}

/** The title a fork starts with. */
export const forkTitle = (title: string) => `${title} (fork)`;

function ForkForm({
  defaultTitle,
  onCreate,
}: {
  defaultTitle: string;
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const trimmed = title.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed !== "") onCreate(trimmed);
      }}
    >
      <Stack gap="sm">
        <Text size="sm">
          Copies the conversation up to this message into a new session. The
          files, notes and data are shared with this one, not copied.
        </Text>
        <TextInput
          label="Title of the new session"
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button type="submit" disabled={trimmed === ""}>
            Fork
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Asks for the new session's title, then forks. */
export function openForkDialog(
  sessionTitle: string,
  onCreate: (title: string) => void,
) {
  const id = modals.open({
    title: "Fork this session",
    children: (
      <ForkForm
        defaultTitle={forkTitle(sessionTitle)}
        onCreate={(title) => {
          modals.close(id);
          onCreate(title);
        }}
      />
    ),
  });
}

/** Under a forked session's title: where it came from. */
export function ForkedFromLine({
  from,
}: {
  from: NonNullable<SessionDetail["forkedFrom"]>;
}) {
  if (from.state === "live" || from.state === "trashed") {
    return (
      <Text size="xs" c="dimmed">
        Forked from{" "}
        <Anchor
          size="xs"
          renderRoot={(props) => (
            <Link
              {...props}
              to="/sessions/$sessionId"
              params={{ sessionId: from.id }}
            />
          )}
        >
          {from.title}
        </Anchor>
        {from.state === "trashed" ? " (in the Trash)" : ""}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      Forked from {from.title} (deleted)
    </Text>
  );
}

/** The box an edit is written in, with Save in the default mode. */
export function EditMessageBox({
  initial,
  hasFiles,
  defaultMode,
  saving,
  onSave,
  onCancel,
}: {
  initial: string;
  /** The message has attached files, which an edit leaves as they are. */
  hasFiles: boolean;
  defaultMode: "branch" | "in_place";
  saving: boolean;
  onSave: (content: string, mode: "branch" | "in_place") => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const other = defaultMode === "branch" ? "in_place" : "branch";
  const empty = text === "" && !hasFiles;
  return (
    <Paper p="sm" withBorder>
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          Editing your message
          {hasFiles ? " (its files stay as they are)" : ""}
        </Text>
        <Textarea
          aria-label="Message text"
          autosize
          minRows={2}
          autoFocus
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Group gap="xs">
          <Group gap={0} wrap="nowrap">
            <Button
              size="xs"
              disabled={empty}
              loading={saving}
              style={{
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
              }}
              onClick={() => onSave(text, defaultMode)}
            >
              Save
            </Button>
            <Menu position="bottom-start" disabled={empty || saving}>
              <Menu.Target>
                <ActionIcon
                  aria-label="Save another way"
                  size={26}
                  variant="filled"
                  disabled={empty || saving}
                  style={{
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: "1px solid var(--mantine-color-body)",
                  }}
                >
                  ▾
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => onSave(text, other)}>
                  {other === "branch"
                    ? "Save as a new branch"
                    : "Save in place (keeps what follows)"}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
          <Button size="xs" variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Text size="xs" c="dimmed">
            {defaultMode === "branch"
              ? "Save keeps the old message and what followed on a branch."
              : "Save overwrites the text and keeps what follows."}
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

/**
 * "2/3": which branch this message starts, with previous and next, and a
 * delete for this branch. Shown on a message that has live siblings.
 */
export function BranchSwitcher({
  branches,
  disabled,
  onSwitch,
  onDelete,
}: {
  branches: NonNullable<StoredMessage["branches"]>;
  disabled: boolean;
  onSwitch: (messageId: string) => void;
  onDelete: (messageId: string) => void;
}) {
  const { ids, index } = branches;
  const previous = ids[index - 1];
  const next = ids[index + 1];
  const current = ids[index];
  return (
    <Group gap={4} mb={4}>
      <ActionIcon
        aria-label="Previous branch"
        size="sm"
        variant="subtle"
        color="gray"
        disabled={disabled || previous === undefined}
        onClick={() => previous && onSwitch(previous)}
      >
        ‹
      </ActionIcon>
      <Text size="xs" c="dimmed" aria-label="Branch">
        {index + 1}/{ids.length}
      </Text>
      <ActionIcon
        aria-label="Next branch"
        size="sm"
        variant="subtle"
        color="gray"
        disabled={disabled || next === undefined}
        onClick={() => next && onSwitch(next)}
      >
        ›
      </ActionIcon>
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        disabled={disabled}
        onClick={() =>
          current &&
          modals.openConfirmModal({
            title: "Delete this branch?",
            children: (
              <Text size="sm">
                This message and everything after it go to the Trash. You can
                restore them from Settings, Trash.
              </Text>
            ),
            labels: { confirm: "Delete branch", cancel: "Cancel" },
            confirmProps: { color: "red" },
            onConfirm: () => onDelete(current),
          })
        }
      >
        Delete branch
      </Button>
    </Group>
  );
}

/**
 * Under the end of the line: the other messages that continue from it, such
 * as what followed before a branch off. Each switches to it.
 */
export function Continuations({
  items,
  disabled,
  onSwitch,
}: {
  items: Branching["continuations"];
  disabled: boolean;
  onSwitch: (messageId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        This point also continues with:
      </Text>
      {items.map((item) => (
        <Button
          key={item.id}
          size="compact-xs"
          variant="light"
          color="gray"
          justify="flex-start"
          disabled={disabled}
          onClick={() => onSwitch(item.id)}
        >
          {item.role === "user" ? "You: " : ""}
          {item.preview === "" ? "(no text)" : item.preview}
        </Button>
      ))}
    </Stack>
  );
}
