import { Alert, Loader, Text } from "@mantine/core";
import { useMemo } from "react";
import { type FileScope } from "../../api";
import { rootsFor, type RootId } from "../../lib/explorer";
import type { StructuredRoot } from "../../lib/structured-explorer";
import { ExplorerShell } from "../explorer/ExplorerShell";
import { StructuredTree } from "./StructuredTree";
import { useStructured } from "../../hooks/useStructured";

export function StructuredRoots({
  roots,
  viewKey,
  pageRoot,
  onDirtyChange,
}: {
  roots: readonly StructuredRoot[];
  viewKey: string;
  pageRoot: RootId;
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

export function StructuredExplorer({
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
