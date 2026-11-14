import { ExplorerPanel } from "../../components/ExplorerPanel";
import { ProjectGate, trashedNote } from "../../components/ProjectGate";
import { FilesExplorer } from "../../components/explorer/FilesExplorer";

export function GlobalFilesPage() {
  return (
    <ExplorerPanel height="calc(100vh - 7rem)">
      {(onDirtyChange) => (
        <FilesExplorer
          page={{ scope: "global" }}
          onDirtyChange={onDirtyChange}
        />
      )}
    </ExplorerPanel>
  );
}

export function ProjectFilesPage({ projectId }: { projectId: string }) {
  return (
    <ProjectGate projectId={projectId}>
      {(project) => (
        <ExplorerPanel key={projectId} height="calc(100vh - 7rem)">
          {(onDirtyChange) => (
            <FilesExplorer
              page={{ scope: "project", id: projectId }}
              readOnly={trashedNote(project, "these")}
              onDirtyChange={onDirtyChange}
            />
          )}
        </ExplorerPanel>
      )}
    </ProjectGate>
  );
}
