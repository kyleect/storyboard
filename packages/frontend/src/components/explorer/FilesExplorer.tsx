import { useMemo } from "react";
import type { FileScope } from "../../api";
import { filesSource, type ExplorerRoot } from "../../lib/explorer-source";
import { isHigherScope, rootsFor } from "../../lib/files-explorer";
import { SourceExplorer } from "./SourceExplorer";

const BROAD: Record<string, string> = {
  project: "Every session in this project sees this file.",
  global: "Every session sees this file.",
};

export function FilesExplorer({
  page,
  projectId,
  readOnly,
  projectReadOnly,
  onDirtyChange,
}: {
  page: FileScope;
  projectId?: string | null | undefined;
  readOnly?: string | undefined;
  projectReadOnly?: string | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const pageScope = page.scope;
  const pageId = "id" in page ? page.id : "";
  const roots = useMemo<ExplorerRoot[]>(() => {
    const stable: FileScope =
      pageScope === "global"
        ? { scope: "global" }
        : { scope: pageScope, id: pageId };
    return rootsFor(stable, projectId).map((r) => ({
      id: r.id,
      label: r.label,
      source: filesSource(r.scope),
      readOnly: r.id === "project" ? (readOnly ?? projectReadOnly) : readOnly,
      broadNote: isHigherScope(r.scope, stable) ? BROAD[r.id] : undefined,
      projectId: r.scope.scope === "project" ? r.scope.id : undefined,
    }));
  }, [pageScope, pageId, projectId, readOnly, projectReadOnly]);
  const pageKey = useMemo<FileScope>(
    () =>
      pageScope === "global"
        ? { scope: "global" }
        : { scope: pageScope, id: pageId },
    [pageScope, pageId],
  );

  return (
    <SourceExplorer
      roots={roots}
      pageRoot={pageScope}
      pageKey={pageKey}
      namespace="files"
      onDirtyChange={onDirtyChange}
    />
  );
}
