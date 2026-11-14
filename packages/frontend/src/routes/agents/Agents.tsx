import { Alert, Box, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { projectKeys } from "../../queries";
import { AgentsExplorer } from "./components/AgentsExplorer";
import { useReportDirty } from "../../stores/dirty";
import { ApprovalSelect } from "./components/ApprovalSelect";

export { ApprovalSelect };

export function GlobalAgentsPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Agents</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <AgentsView height="calc(100vh - 17rem)" />
    </Stack>
  );
}

function AgentsView({
  projectId,
  readOnly,
  height,
}: {
  projectId?: string;
  readOnly?: string | undefined;
  height: string;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <Box h={height} mih={420}>
      <AgentsExplorer
        projectId={projectId}
        readOnly={readOnly}
        onDirtyChange={setDirty}
      />
    </Box>
  );
}

export function ProjectAgentsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <AgentsView
      key={projectId}
      height="calc(100vh - 7rem)"
      projectId={projectId}
      readOnly={
        trashed
          ? "The project is in the trash, so these can be read but not changed."
          : undefined
      }
    />
  );
}
