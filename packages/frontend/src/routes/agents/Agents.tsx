import { ExplorerPanel } from "../../components/ExplorerPanel";
import { ProjectGate, trashedNote } from "../../components/ProjectGate";
import { AgentsExplorer } from "./components/AgentsExplorer";

export function GlobalAgentsPage() {
  return (
    <ExplorerPanel height="calc(100vh - 7rem)">
      {(onDirtyChange) => <AgentsExplorer onDirtyChange={onDirtyChange} />}
    </ExplorerPanel>
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
