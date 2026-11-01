import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Session } from "../api";

/*
 * Renaming a session and moving it to the trash, shared by the navbar and
 * the chat view (sessions and projects design, Q1, Q4). Modal content is
 * rendered outside the query client's provider, so it only gets callbacks.
 */

export const showError = (title: string) => (err: unknown) =>
  notifications.show({
    color: "red",
    title,
    message: err instanceof Error ? err.message : String(err),
  });

export function useSessionActions() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });

  /** Refetches every view that shows the session. */
  const refresh = async (id: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["session", id] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
  };

  /** Renames; throws when the backend refuses. */
  const rename = async (id: string, title: string) => {
    await api.renameSession(id, title);
    await refresh(id);
  };

  const openRename = (session: Session) => {
    const modalId = modals.open({
      title: "Rename session",
      children: (
        <RenameForm
          initial={session.title}
          onCancel={() => modals.close(modalId)}
          onSubmit={async (title) => {
            await rename(session.id, title);
            modals.close(modalId);
          }}
        />
      ),
    });
  };

  const confirmTrash = (session: Session) => {
    modals.openConfirmModal({
      title: "Move to trash?",
      children: (
        <Text size="sm">
          “{session.title}” moves to the trash. You can restore it from the
          Trash section in Settings.
        </Text>
      ),
      labels: { confirm: "Move to trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .trashSession(session.id)
          .then(async () => {
            if (params.sessionId === session.id) await navigate({ to: "/" });
            await refresh(session.id);
          })
          .catch(showError("Could not move to trash"));
      },
    });
  };

  const restore = async (id: string) => {
    await api.restoreSession(id);
    await refresh(id);
  };

  return { rename, openRename, confirmTrash, restore, refresh };
}

/** A title field: trimmed, not empty (design Q2). */
function RenameForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = title.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        setSaving(true);
        onSubmit(trimmed).catch((err: unknown) => {
          setSaving(false);
          setError(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <Stack gap="sm">
        <TextInput
          label="Title"
          data-autofocus
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setError(null);
          }}
          error={error ?? (trimmed ? null : "A title is required")}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed} loading={saving}>
            Rename
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
