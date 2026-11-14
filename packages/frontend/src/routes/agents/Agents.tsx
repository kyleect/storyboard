import { Stack, Text, Title } from "@mantine/core";
import { ExplorerPanel } from "../../components/ExplorerPanel";
import { ProjectGate, trashedNote } from "../../components/ProjectGate";
import { AgentsExplorer } from "./components/AgentsExplorer";

export function GlobalAgentsPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Agents</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <ExplorerPanel height="calc(100vh - 17rem)">
        {(onDirtyChange) => <AgentsExplorer onDirtyChange={onDirtyChange} />}
      </ExplorerPanel>
    </Stack>
  );
}

export function ProjectAgentsPage({ projectId }: { projectId: string }) {
  return (
    <ProjectGate projectId={projectId}>
      {(project) => (
        <ExplorerPanel key={projectId} height="calc(100vh - 7rem)">
          {(onDirtyChange) => (
            <AgentsExplorer
              projectId={projectId}
              readOnly={trashedNote(project, "these")}
              onDirtyChange={onDirtyChange}
            />
          )}
        </ExplorerPanel>
      )}
    </ProjectGate>
  );
}
