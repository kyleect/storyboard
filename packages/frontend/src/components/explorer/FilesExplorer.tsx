import { Alert, Loader } from "@mantine/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type FileScope, type Workspace } from "../../api";
import { confirmAction } from "../../lib/confirm";
import { filesSource, type ExplorerRoot } from "../../lib/explorer-source";
import {
  isHigherScope,
  rootsFor,
  type NodeGroup,
  type NodeRef,
} from "../../lib/files-explorer";
import { showError } from "../../lib/notify";
import {
  isWorkspaceRoot,
  workspaceIdOf,
  workspaceRoot,
  WORKSPACE_GROUP,
} from "../../lib/workspace-source";
import { workspaceKeys } from "../../queries";
import { isRootId } from "../../lib/explorer";
import { SourceExplorer, type CustomTab } from "./SourceExplorer";
import { NewWorkspace, WorkspaceSettings } from "./WorkspaceTab";

const BROAD: Record<string, string> = {
  project: "Every session in this project sees this file.",
  global: "Every session sees this file.",
};

const GROUP_LABEL = {
  session: "Session",
  project: "Project",
  global: "Global",
} as const;

const isFilesRoot = (v: unknown): boolean => isRootId(v) || isWorkspaceRoot(v);

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
  const queryClient = useQueryClient();
  const pageScope = page.scope;
  const pageId = "id" in page ? page.id : "";
  const stable = useMemo<FileScope>(
    () =>
      pageScope === "global"
        ? { scope: "global" }
        : { scope: pageScope, id: pageId },
    [pageScope, pageId],
  );
  const fileRoots = useMemo(
    () => rootsFor(stable, projectId),
    [stable, projectId],
  );
  // The workspaces of each scope the page shows, the ones in the trash too.
  const scopes = useMemo(() => fileRoots.map((r) => r.scope), [fileRoots]);
  const lists = useQueries({
    queries: scopes.flatMap((scope) =>
      [false, true].map((deleted) => ({
        queryKey: workspaceKeys.list(scope, deleted),
        queryFn: () => api.listWorkspaces(scope, deleted),
      })),
    ),
    combine: (results) => ({
      data: results.map((r) => r.data),
      error: results.find((r) => r.error)?.error ?? null,
      pending: results.some((r) => r.isPending),
    }),
  });
  const workspaces = useMemo<Map<string, Workspace[]>>(
    () =>
      new Map(
        fileRoots.map((r, i) => [
          r.id,
          [
            ...((lists.data[i * 2] as Workspace[] | undefined) ?? []),
            ...((lists.data[i * 2 + 1] as Workspace[] | undefined) ?? []),
          ],
        ]),
      ),
    [fileRoots, lists.data],
  );
  const roots = useMemo<ExplorerRoot[]>(
    () => [
      ...fileRoots.map((r) => ({
        id: r.id,
        label: r.label,
        source: filesSource(r.scope),
        readOnly: r.id === "project" ? (readOnly ?? projectReadOnly) : readOnly,
        broadNote: isHigherScope(r.scope, stable) ? BROAD[r.id] : undefined,
        projectId: r.scope.scope === "project" ? r.scope.id : undefined,
      })),
      ...fileRoots.flatMap((r) =>
        (workspaces.get(r.id) ?? []).map((w) => workspaceRoot(w, r.id, stable)),
      ),
    ],
    [fileRoots, workspaces, stable, readOnly, projectReadOnly],
  );
  const groups = useMemo<NodeGroup[]>(
    () =>
      fileRoots.map((r) => ({
        id: r.id,
        label: GROUP_LABEL[r.id as keyof typeof GROUP_LABEL],
      })),
    [fileRoots],
  );
  const everyWorkspace = useMemo(
    () => [...workspaces.values()].flat(),
    [workspaces],
  );
  const scopeOfGroup = (group: string): FileScope | undefined =>
    fileRoots.find((r) => r.id === group)?.scope;
  const refreshWorkspaces = () =>
    queryClient.invalidateQueries({ queryKey: workspaceKeys.all });

  const customTab = useMemo<CustomTab>(
    () => ({
      label: (t) => {
        const w = everyWorkspace.find((x) => x.id === workspaceIdOf(t.root));

        if (w) return `${w.name} · Workspace`;

        return t.key === "new-temporary"
          ? "New temporary workspace"
          : "New workspace";
      },
      render: (t, close) => {
        const w = everyWorkspace.find((x) => x.id === workspaceIdOf(t.root));

        if (w)
          return (
            <WorkspaceSettings workspace={w} scope={stable} onClose={close} />
          );

        const scope = scopeOfGroup(t.root.slice(WORKSPACE_GROUP.length));

        return scope ? (
          <NewWorkspace
            scope={scope}
            temporary={t.key === "new-temporary"}
            onDone={close}
            onClose={close}
          />
        ) : null;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeOfGroup reads fileRoots
    [everyWorkspace, fileRoots, stable],
  );

  const nodeActions = (
    ref: NodeRef,
    control: Parameters<
      NonNullable<React.ComponentProps<typeof SourceExplorer>["nodeActions"]>
    >[1],
  ) => {
    if (ref.kind !== "root") return [];

    if (ref.root.startsWith(WORKSPACE_GROUP)) {
      const group = ref.root.slice(WORKSPACE_GROUP.length);
      const scope = scopeOfGroup(group);
      const locked = readOnly !== undefined && group === pageScope;
      const actions = [
        {
          label: "New workspace",
          onClick: () =>
            control.open({ kind: "workspace", root: ref.root, key: "new" }),
        },
      ];

      if (scope?.scope === "session") {
        actions.push({
          label: "New temporary workspace",
          onClick: () =>
            control.open({
              kind: "workspace",
              root: ref.root,
              key: "new-temporary",
            }),
        });
      }

      return locked ? [] : actions;
    }

    const w = everyWorkspace.find((x) => x.id === workspaceIdOf(ref.root));

    if (!w) return [];

    if (w.deleted) {
      return [
        {
          label: "Restore",
          onClick: () =>
            void api
              .restoreWorkspace(w.id)
              .then(refreshWorkspaces)
              .catch(showError("Could not restore")),
        },
      ];
    }

    return [
      {
        label: "Settings",
        onClick: () =>
          control.open({ kind: "workspace", root: ref.root, key: "" }),
      },
      {
        label: "Rescan",
        onClick: () =>
          void api
            .rescanWorkspace(w.id)
            .then(() => control.refresh(ref.root))
            .catch(showError("Could not rescan")),
      },
      w.temporary
        ? {
            label: "Delete",
            onClick: () =>
              confirmAction({
                title: `Delete the temporary workspace “${w.name}”?`,
                message: <>Its folder and everything in it is deleted.</>,
                confirm: "Delete",
                cancel: "Cancel",
                danger: true,
                onConfirm: () =>
                  void api
                    .trashWorkspace(w.id)
                    .then(refreshWorkspaces)
                    .catch(showError("Could not delete the workspace")),
              }),
          }
        : {
            label: "Move to trash",
            onClick: () =>
              void api
                .trashWorkspace(w.id)
                .then(refreshWorkspaces)
                .catch(showError("Could not move to the trash")),
          },
    ];
  };

  if (lists.pending)
    return <Loader size="sm" m="sm" aria-label="Loading the files" />;

  return (
    <>
      {lists.error && (
        <Alert color="red" m="xs" p="xs">
          {lists.error.message}
        </Alert>
      )}
      <SourceExplorer
        roots={roots}
        pageRoot={pageScope}
        pageKey={stable}
        namespace="files"
        isRoot={isFilesRoot}
        groups={groups}
        customTab={customTab}
        nodeActions={nodeActions}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}
