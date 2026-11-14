import { useQuery } from "@tanstack/react-query";
import type { ProjectColor } from "@harness/core";
import { api } from "../api";
import { projectKeys } from "../queries";

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
