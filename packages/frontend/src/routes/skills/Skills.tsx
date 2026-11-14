import { ExplorerPanel } from "../../components/ExplorerPanel";
import { ProjectGate, trashedNote } from "../../components/ProjectGate";
import { SkillsExplorer } from "./components/SkillsExplorer";

export function GlobalSkillsPage() {
  return (
    <ExplorerPanel>
      {(onDirtyChange) => <SkillsExplorer onDirtyChange={onDirtyChange} />}
    </ExplorerPanel>
  );
}

export function ProjectSkillsPage({ projectId }: { projectId: string }) {
  return (
    <ProjectGate projectId={projectId}>
      {(project) => (
        <ExplorerPanel key={projectId}>
          {(onDirtyChange) => (
            <SkillsExplorer
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
