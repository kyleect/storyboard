import { useQuery } from "@tanstack/react-query";
import type { ProjectColor } from "@harness/core";
import { api } from "./api";
import { projectKeys } from "./queries";

/**
 * Looks up a project's color from the project list the chats tree keeps
 * loaded. It reads the cache and never fetches, so a view that shows a
 * project's things can wear its color without a request of its own. Null for
 * no project, an unknown one or a project without a color.
 */
export function useProjectColor(): (
  projectId: string | null | undefined,
) => ProjectColor | null {
  const projects = useQuery({
    queryKey: projectKeys.list(),
    queryFn: api.listProjects,
    enabled: false,
  });
  return (projectId) =>
    projectId
      ? (projects.data?.find((p) => p.id === projectId)?.color ?? null)
      : null;
}
