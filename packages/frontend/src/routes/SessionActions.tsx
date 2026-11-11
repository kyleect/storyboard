import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Project, type Session } from "../api";
import { projectKeys, sessionKeys, trashKeys } from "../queries";
import { dropDraft } from "../drafts";
import { closeTabsAndGo, useWorkbench } from "../workbenchStore";
import { tabsForProject, tabsForSession } from "../workbench";

/*
 * Session and project actions shared by the navbar, the chat view, the
 * project page and Settings (sessions and projects design, Q1, Q4, Q12b,
 * Q17). Modal content is rendered outside the query client's provider, so
 * it only gets callbacks.
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
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: trashKeys.all }),
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
          Trash tab in Settings.
        </Text>
      ),
      labels: { confirm: "Move to trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .trashSession(session.id)
          .then(async () => {
            dropDraft(session.id);
            const closed = closeTabsAndGo(
              tabsForSession(useWorkbench.getState().tabs, session.id),
            );
            if (!closed && params.sessionId === session.id)
              await navigate({ to: "/" });
            await refresh(session.id);
          })
          .catch(showError("Could not move to trash"));
      },
    });
  };

  /**
   * Asks, then moves the sessions to the trash. The ones the backend
   * refuses (a run started, or already in the trash) are reported in a
   * notification, and the rest are moved (Sessions page plan, D4, P3).
   * `onDone` runs after the call, moved or refused.
   */
  const confirmTrashMany = (ids: readonly string[], onDone: () => void) => {
    const count = ids.length;
    const noun = count === 1 ? "session" : "sessions";
    modals.openConfirmModal({
      title: `Move ${count} ${noun} to trash?`,
      children: (
        <Text size="sm">
          {count === 1 ? "It moves" : `All ${count} move`} to the trash. You can
          restore {count === 1 ? "it" : "them"} from the Trash section in
          Settings.
        </Text>
      ),
      labels: { confirm: "Move to trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .trashSessions(ids)
          .then(async (result) => {
            const refused = new Set(result.refused.map((r) => r.id));
            for (const id of ids) {
              if (refused.has(id)) continue;
              dropDraft(id);
              closeTabsAndGo(tabsForSession(useWorkbench.getState().tabs, id));
            }
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
              queryClient.invalidateQueries({ queryKey: trashKeys.all }),
            ]);
            if (result.refused.length > 0) {
              const reasons = [...new Set(result.refused.map((r) => r.error))];
              const n = result.refused.length;
              notifications.show({
                color: "yellow",
                title: `${n} ${n === 1 ? "session was" : "sessions were"} not moved`,
                message: reasons.join(" "),
              });
            }
            onDone();
          })
          .catch(showError("Could not move to trash"));
      },
    });
  };

  /** Refetches every view that shows projects. */
  const refreshProjects = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectKeys.list() }),
      queryClient.invalidateQueries({ queryKey: projectKeys.details() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.details() }),
      queryClient.invalidateQueries({ queryKey: trashKeys.all }),
    ]);
  };

  /**
   * Restores a session. When its project is in the trash, asks first
   * whether the project comes back with all the sessions trashed with it,
   * or with only this one (design Q12b). Resolves when done or cancelled.
   */
  const restore = (session: Session, trashedProject?: Project | null) => {
    if (!trashedProject) {
      return api.restoreSession(session.id).then(() => refreshProjects());
    }
    return new Promise<void>((resolve, reject) => {
      let chosen = false;
      const choose = (choice: "all" | "only") => {
        chosen = true;
        modals.close(modalId);
        api
          .restoreSession(session.id, choice)
          .then(() => refreshProjects())
          .then(resolve, reject);
      };
      const modalId = modals.open({
        title: "Restore the project too?",
        // Closed without a choice: nothing to do.
        onClose: () => {
          if (!chosen) resolve();
        },
        children: (
          <Stack gap="sm">
            <Text size="sm">
              “{session.title}” is in the project “{trashedProject.name}”, which
              is in the trash. Restoring the session restores the project.
            </Text>
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => modals.close(modalId)}>
                Cancel
              </Button>
              <Button variant="light" onClick={() => choose("only")}>
                Only this session
              </Button>
              <Button onClick={() => choose("all")}>
                With all its sessions
              </Button>
            </Group>
          </Stack>
        ),
      });
    });
  };

  return {
    rename,
    openRename,
    confirmTrash,
    confirmTrashMany,
    restore,
    refresh,
    refreshProjects,
  };
}

export function useProjectActions() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refreshProjects } = useSessionActions();

  /** Opens the New project dialog; `onCreated` gets the new project. */
  const openCreate = (onCreated: (project: Project) => void) => {
    const modalId = modals.open({
      title: "New project",
      children: (
        <ProjectForm
          submitLabel="Create"
          onCancel={() => modals.close(modalId)}
          onSubmit={async (fields) => {
            const project = await api.createProject(fields);
            await refreshProjects();
            modals.close(modalId);
            onCreated(project);
          }}
        />
      ),
    });
  };

  const confirmTrash = (project: Project) => {
    modals.openConfirmModal({
      title: "Move project to trash?",
      children: (
        <Text size="sm">
          “{project.name}” and all its sessions move to the trash. You can
          restore them from the Trash tab in Settings.
        </Text>
      ),
      labels: { confirm: "Move to trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .trashProject(project.id)
          .then(async () => {
            // Its pages close, and so do the chats of its sessions.
            const projectOfSession = (id: string) =>
              queryClient.getQueryData<{
                session: { project_id: string | null };
              }>(sessionKeys.detail(id))?.session.project_id ?? null;
            const tabs = useWorkbench.getState().tabs;
            for (const t of tabs)
              if (t.kind === "chat" && projectOfSession(t.key) === project.id)
                dropDraft(t.key);
            const closed = closeTabsAndGo(
              tabsForProject(tabs, project.id, projectOfSession),
            );
            if (!closed) await navigate({ to: "/" });
            await refreshProjects();
          })
          .catch(showError("Could not move to trash"));
      },
    });
  };

  return { openCreate, confirmTrash, refreshProjects };
}

/** The ⋯ menu on a session's entry: Rename, Move to trash. */
export function SessionMenu({ session }: { session: Session }) {
  const actions = useSessionActions();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Actions for ${session.title}`}
          // The entry is a link; the menu must not follow it.
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ⋯
        </ActionIcon>
      </Menu.Target>
      {/* The menu is drawn elsewhere, but its clicks still reach the row. */}
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
        <Menu.Item onClick={() => actions.openRename(session)}>
          Rename
        </Menu.Item>
        <Menu.Item color="red" onClick={() => actions.confirmTrash(session)}>
          Move to trash
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Name (trimmed, not empty) and description of a new project (Q9, Q17). */
function ProjectForm({
  submitLabel,
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  onSubmit: (fields: { name: string; description: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        setSaving(true);
        onSubmit({ name: trimmed, description }).catch((err: unknown) => {
          setSaving(false);
          setError(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <Stack gap="sm">
        <TextInput
          label="Name"
          data-autofocus
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setError(null);
          }}
          error={error}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          maxRows={8}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed} loading={saving}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
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
