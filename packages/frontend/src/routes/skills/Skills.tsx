import { Stack, Title } from "@mantine/core";
import { ExplorerPanel } from "../../components/ExplorerPanel";
import {
  ProjectGate,
  ProjectScopeNote,
  trashedNote,
} from "../../components/ProjectGate";
import { SkillsExplorer } from "./components/SkillsExplorer";

export function GlobalSkillsPage() {
  return (
    <ExplorerPanel height="calc(100vh - 11rem)">
      {(onDirtyChange) => <SkillsExplorer onDirtyChange={onDirtyChange} />}
    </ExplorerPanel>
  );
}

export function ProjectSkillsPage({ projectId }: { projectId: string }) {
  return (
    <ProjectGate projectId={projectId}>
      {(project) => (
        <Stack gap="md">
          <Title order={3}>Skills</Title>
          <ProjectScopeNote project={project} />
          <ExplorerPanel key={projectId} height="calc(100vh - 16rem)">
            {(onDirtyChange) => (
              <SkillsExplorer
                projectId={projectId}
                readOnly={trashedNote(project, "these")}
                onDirtyChange={onDirtyChange}
              />
            )}
          </ExplorerPanel>
        </Stack>
      )}
    </ProjectGate>
  );
}
