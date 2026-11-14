import { Stack, Title } from "@mantine/core";
import { ExplorerPanel } from "../../components/ExplorerPanel";
import {
  ProjectGate,
  ProjectScopeNote,
  trashedNote,
} from "../../components/ProjectGate";
import { StructuredExplorer } from "../../components/structured/StructuredExplorer";

export function GlobalStructuredDataPage() {
  return (
    <ExplorerPanel height="calc(100vh - 8rem)">
      {(onDirtyChange) => (
        <StructuredExplorer
          page={{ scope: "global" }}
          onDirtyChange={onDirtyChange}
        />
      )}
    </ExplorerPanel>
  );
}

export function ProjectStructuredDataPage({
  projectId,
}: {
  projectId: string;
}) {
  return (
    <ProjectGate projectId={projectId}>
      {(project) => (
        <Stack gap="md">
          <Title order={3}>Structured Data</Title>
          <ProjectScopeNote project={project} />
          <ExplorerPanel key={projectId} height="calc(100vh - 14rem)">
            {(onDirtyChange) => (
              <StructuredExplorer
                page={{ scope: "project", id: projectId }}
                readOnly={trashedNote(project, "its data")}
                onDirtyChange={onDirtyChange}
              />
            )}
          </ExplorerPanel>
        </Stack>
      )}
    </ProjectGate>
  );
}
