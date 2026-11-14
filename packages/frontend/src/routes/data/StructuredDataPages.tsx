import { ExplorerPanel } from "../../components/ExplorerPanel";
import { ProjectGate, trashedNote } from "../../components/ProjectGate";
import { StructuredExplorer } from "../../components/structured/StructuredExplorer";

export function GlobalStructuredDataPage() {
  return (
    <ExplorerPanel>
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
        <ExplorerPanel key={projectId}>
          {(onDirtyChange) => (
            <StructuredExplorer
              page={{ scope: "project", id: projectId }}
              readOnly={trashedNote(project, "its data")}
              onDirtyChange={onDirtyChange}
            />
          )}
        </ExplorerPanel>
      )}
    </ProjectGate>
  );
}
