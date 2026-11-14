import { Button, Group, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { api, type Project, type Session } from "../api";
import { RenameForm } from "../components/RenameForm";
import { showError } from "../lib/notify";
import { tabsForSession } from "../lib/workbench";
import { sessionKeys, projectKeys, trashKeys } from "../queries";
import { dropDraft } from "../stores/drafts";
import { closeTabsAndGo, useWorkbench } from "../stores/workbench";

export function useSessionActions() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });

  const refresh = async (id: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: trashKeys.all }),
    ]);
  };

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

  const refreshProjects = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectKeys.list() }),
      queryClient.invalidateQueries({ queryKey: projectKeys.details() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
      queryClient.invalidateQueries({ queryKey: sessionKeys.details() }),
      queryClient.invalidateQueries({ queryKey: trashKeys.all }),
    ]);
  };

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
