import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { showError } from "../lib/notify";
import { projectKeys, sessionKeys } from "../queries";

export function useSession(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: () => api.getSession(sessionId),
  });
}

export function useCreateSession(
  onCreated: (session: { id: string }) => void | Promise<void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string | null) => api.createSession(projectId),
    onSuccess: async (session, projectId) => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      if (projectId !== null)
        await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      await onCreated(session);
    },
    onError: showError("Could not create a session"),
  });
}
