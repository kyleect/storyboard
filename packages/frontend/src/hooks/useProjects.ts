import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectColor } from "@harness/core";
import { api, type Project, type SettingsView } from "../api";
import { showError } from "../lib/notify";
import { agentKeys, projectKeys, sessionKeys, settingsKeys } from "../queries";

/** Every project, most recently used first. */
export function useProjects() {
  return useQuery({ queryKey: projectKeys.list(), queryFn: api.listProjects });
}

/** One project. With no id nothing is fetched. */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(projectId ?? ""),
    queryFn: () => api.getProject(projectId ?? ""),
    enabled: projectId !== undefined,
  });
}

/**
 * Saves changes to a project and puts the result in the cache. Editing a
 * project counts as using it, so the list, which is ordered by use, is
 * refetched.
 */
export function useSaveProject(projectId: string) {
  const queryClient = useQueryClient();
  return async (fields: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    color?: ProjectColor | null;
  }) => {
    const updated = await api.updateProject(projectId, fields);
    queryClient.setQueryData<Project>(projectKeys.detail(projectId), updated);
    await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
  };
}

/**
 * Sets the default agent of a project, or of the app when there is no
 * `projectId`. `null` clears it.
 */
export function useSetDefaultAgent(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation<Project | SettingsView, Error, string | null>({
    mutationFn: (agentId) =>
      projectId
        ? api.updateProject(projectId, { defaultAgentId: agentId })
        : api.saveSettings({ defaultAgentId: agentId ?? "" }),
    onSuccess: async (result) => {
      if (projectId) {
        queryClient.setQueryData<Project>(
          projectKeys.detail(projectId),
          result as Project,
        );
        await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      } else {
        queryClient.setQueryData(settingsKeys.all, result);
      }
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      await queryClient.invalidateQueries({
        queryKey: sessionKeys.pickableAgents(),
      });
    },
    onError: showError("Could not set the default agent"),
  });
}
