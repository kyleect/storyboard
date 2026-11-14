import { Alert, Loader, Text } from "@mantine/core";
import { useMemo } from "react";
import { type FileScope } from "../../api";
import { rootsFor, type RootId } from "../../lib/explorer";
import type { StructuredRoot } from "../../lib/structured-explorer";
import { ExplorerShell } from "../explorer/ExplorerShell";
import { StructuredTree } from "./StructuredTree";
import { useStructured } from "../../hooks/useStructured";

/*
 * The Structured Data view: an editor-style explorer for schemas and data.
 * A tree on the left has a root folder for each root it is given; each has
 * a Schemas folder holding the schemas it can make data from, each with its
 * data. Schemas and data open as tabs on the right, as a form with a JSON
 * view beside it. `StructuredExplorer` is the view for a page, whose roots
 * are the scopes it can see (a session sees Session, Project and Global; a
 * project, Project and Global; the global page, Global); `StructuredRoots`
 * is the same view over any roots. The logic is in `useStructured`, and the
 * rules for roots, the tree and the tabs in `explorer.ts` and
 * `structured-explorer.ts`.
 */

/** The view over roots the caller chooses. */
export function StructuredRoots({
  roots,
  viewKey,
  pageRoot,
  onDirtyChange,
}: {
  /** One value while the roots stay the same: they are what the view depends on. */
  roots: readonly StructuredRoot[];
  /** What the open tabs and the tree's folds are remembered under. */
  viewKey: string;
  /** The root that is the view's own, which a new schema or data goes to. */
  pageRoot: RootId;
  /** Whether there are unsaved edits, for a guard against leaving. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const s = useStructured({ roots, viewKey, pageRoot, onDirtyChange });
  return <StructuredLayout s={s} />;
}

function StructuredLayout({ s }: { s: ReturnType<typeof useStructured> }) {
  const sidebar = s.loading ? (
    <Loader size="sm" m="sm" aria-label="Loading the structured data" />
  ) : (
    <>
      {s.loadError && (
        <Alert color="red" m="xs" p="xs">
          {s.loadError.message}
        </Alert>
      )}
      <StructuredTree {...s.treeProps} />
    </>
  );

  return (
    <>
      <ExplorerShell
        width={s.width}
        onWidthChange={s.setWidth}
        sidebar={sidebar}
        tabs={s.tabs}
        active={s.active}
        onActivate={s.setActive}
        onKeep={s.keep}
        onRequestClose={s.requestClose}
        content={s.content}
        empty="Open a schema or data from the tree."
        tabListLabel="Open schemas and data"
        resizeLabel="Resize the structured data tree"
        statusLeft={s.activeWhere ?? "Nothing open"}
        statusRight={
          s.activeKind && (
            <>
              <Text size="xs" c="dimmed">
                {s.activeKind === "schema" ? "Schema" : "Data"}
              </Text>
              <Text size="xs" c={s.activeDirty ? "yellow" : "dimmed"}>
                {s.activeReason
                  ? "Read-only"
                  : s.activeDirty
                    ? "Unsaved changes"
                    : "Saved"}
              </Text>
            </>
          )
        }
      />
      {s.copyModal}
    </>
  );
}

/** The view for a page: the scopes it can see. */
export function StructuredExplorer({
  page,
  projectId,
  readOnly,
  projectReadOnly,
  onDirtyChange,
}: {
  /** The scope of the page: where its own schemas and data live. */
  page: FileScope;
  /** The session's project, if it has one. */
  projectId?: string | null | undefined;
  /** Why no root can be changed, when that is so. */
  readOnly?: string | undefined;
  /** Why the project's schemas and data cannot be changed, when that is so. */
  projectReadOnly?: string | undefined;
  /** Whether there are unsaved edits, for a guard against leaving. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  // Callers may pass a new object each render; everything below depends on
  // this one, which changes only with the page.
  const pageScope = page.scope;
  const pageId = "id" in page ? page.id : "";
  const stablePage = useMemo<FileScope>(
    () =>
      pageScope === "global"
        ? { scope: "global" }
        : { scope: pageScope, id: pageId },
    [pageScope, pageId],
  );
  const roots = useMemo<StructuredRoot[]>(
    () =>
      rootsFor(stablePage, projectId).map((r) => ({
        ...r,
        readOnly:
          readOnly ?? (r.id === "project" ? projectReadOnly : undefined),
      })),
    [stablePage, projectId, readOnly, projectReadOnly],
  );
  const s = useStructured({
    roots,
    viewKey: stablePage,
    pageRoot: pageScope,
    onDirtyChange,
  });
  return <StructuredLayout s={s} />;
}
