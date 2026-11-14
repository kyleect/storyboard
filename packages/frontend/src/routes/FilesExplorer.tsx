import { useMemo } from "react";
import type { FileScope } from "../api";
import { filesSource, type ExplorerRoot } from "../explorer-source";
import { isHigherScope, rootsFor } from "../files-explorer";
import { SourceExplorer } from "./SourceExplorer";

/*
 * The Files view: `SourceExplorer` over the files a page can see. A session
 * sees Session, Project and Global; a project, Project and Global; the global
 * page, Global (Kylee's decisions of 2026-11-11). Which root can be changed,
 * and which ask before saving, is decided here; the explorer itself knows
 * nothing about files' scopes.
 */

/** What saving to a root above the page reaches. */
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
  /** The scope of the page: where its own files live. */
  page: FileScope;
  /** The session's project, if it has one. */
  projectId?: string | null | undefined;
  /** Why no root can be changed, when that is so. */
  readOnly?: string | undefined;
  /** Why the project's files cannot be changed, when that is so. */
  projectReadOnly?: string | undefined;
  /** Whether there are unsaved edits, for a guard against leaving. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  // Callers may pass a new object each render; everything below depends on
  // these, which change only with the page.
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
