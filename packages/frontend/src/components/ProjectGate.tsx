import { Alert, Anchor, Loader, Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Project } from "../api";
import { useProject } from "../hooks/useProjects";

export function ProjectGate({
  projectId,
  children,
}: {
  projectId: string;
  children: (project: Project) => ReactNode;
}) {
  const project = useProject(projectId);
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  return <>{children(project.data)}</>;
}

export const trashedNote = (project: Project, what: string) =>
  project.trashed_at !== null
    ? `The project is in the trash, so ${what} can be read but not changed.`
    : undefined;

export function ProjectScopeNote({ project }: { project: Project }) {
  return (
    <Text size="sm" c="dimmed">
      Project{" "}
      <Anchor
        renderRoot={(props) => (
          <Link
            {...props}
            to="/projects/$projectId"
            params={{ projectId: project.id }}
          />
        )}
      >
        {project.name}
      </Anchor>
      : sessions in this project can use these, as well as the global ones.
    </Text>
  );
}
