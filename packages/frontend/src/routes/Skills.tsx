import { Alert, Anchor, Box, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { useReportDirty } from "../dirty";
import { projectKeys } from "../queries";
import { SkillsExplorer } from "./SkillsExplorer";

/*
 * Skills: the global and the project page, each the skills explorer
 * (`SkillsExplorer.tsx`). An agent's own skills are edited under the agent, in
 * the Agents view.
 */

/** The skills explorer, with the guard against leaving unsaved edits. */
function SkillsView({
  projectId,
  readOnly,
  height = "calc(100vh - 16rem)",
}: {
  projectId?: string;
  readOnly?: string | undefined;
  height?: string;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <Box h={height} mih={420}>
      <SkillsExplorer
        projectId={projectId}
        readOnly={readOnly}
        onDirtyChange={setDirty}
      />
    </Box>
  );
}

/** Global skills: the explorer, with the built-in skills and the global ones. */
export function GlobalSkillsPage() {
  return <SkillsView height="calc(100vh - 11rem)" />;
}

/** A project's skills, with the global and built-in ones shown too. */
export function ProjectSkillsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <Stack gap="md">
      <Title order={3}>Skills</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : sessions in this project can use these, as well as the global ones.
      </Text>
      <SkillsView
        key={projectId}
        projectId={projectId}
        readOnly={
          trashed
            ? "The project is in the trash, so these can be read but not changed."
            : undefined
        }
      />
    </Stack>
  );
}
