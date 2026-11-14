import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, type Project } from "../api";
import { ProjectForm } from "../components/ProjectForm";
import { showError } from "../lib/notify";
import { tabsForProject } from "../lib/workbench";
import { sessionKeys } from "../queries";
import { dropDraft } from "../stores/drafts";
import { closeTabsAndGo, useWorkbench } from "../stores/workbench";
import { useSessionActions } from "./useSessionActions";

export function useProjectActions() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refreshProjects } = useSessionActions();

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
