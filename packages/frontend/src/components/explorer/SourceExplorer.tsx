import { Alert, Loader, Text } from "@mantine/core";
import { confirmAction } from "../../lib/confirm";
import { notifications } from "@mantine/notifications";
import { IconBook } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fileNameProblem, joinPath, type ProjectColor } from "@harness/core";
import type { StoredFile } from "../../api";
import {
  ACCEPTED_DESCRIPTION,
  attachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from "../../lib/attachments";
import { loadViewIn, saveViewIn, type PageKey } from "../../lib/explorer";
import type { ExplorerRoot, ExplorerSource } from "../../lib/explorer-source";
import {
  baseName,
  buildTree,
  closeTab,
  dirName,
  emptyValueFor,
  FILE_TAB_KINDS,
  keepTab,
  mediaTypeForName,
  nodeValue,
  openTab,
  renameFolderInTabs,
  tabId,
  type NodeRef,
  type Pending,
  type RootId,
  type TabState,
} from "../../lib/files-explorer";
import { ExplorerShell, type ShellTab } from "./ExplorerShell";
import { useProjectColor } from "../../hooks/useProjectColor";
import { FileIcon, FileTree, type NodeAction } from "./FileTree";
import { FileTab, PreviewTab, type Draft } from "./FileTab";
import type { Cursor } from "./TextEditor";
import { showError } from "../../lib/notify";

const combineResults = (
  results: { data: unknown; error: Error | null; isPending: boolean }[],
) => ({
  data: results.map((r) => r.data),
  error: results.find((r) => r.error)?.error ?? null,
  pending: results.some((r) => r.isPending),
});

export function SourceExplorer({
  roots,
  pageRoot,
  pageKey,
  namespace,
  isRoot,
  onDirtyChange,
  extraTools,
  nodeActions,
}: {
  roots: readonly ExplorerRoot[];
  pageRoot: RootId;
  pageKey: PageKey;
  namespace: string;
  isRoot?: ((v: unknown) => boolean) | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  extraTools?: React.ReactNode;
  nodeActions?: ((ref: NodeRef) => NodeAction[]) | undefined;
}) {
  const queryClient = useQueryClient();
  const rootOf = (id: RootId): ExplorerRoot | undefined =>
    roots.find((r) => r.id === id);
  const labelOf = (id: RootId): string => rootOf(id)?.label ?? id;

  const reasons = useMemo(
    () =>
      Object.fromEntries(roots.map((r) => [r.id, r.readOnly])) as Record<
        RootId,
        string | undefined
      >,
    [roots],
  );

  const [initial] = useState(() =>
    loadViewIn(namespace, pageKey, FILE_TAB_KINDS, isRoot),
  );
  const [tabsState, setTabsState] = useState(() => {
    const tabs = initial.tabs.filter((t) => roots.some((r) => r.id === t.root));
    const active = tabs.some((t) => tabId(t) === initial.active)
      ? initial.active
      : tabs[0]
        ? tabId(tabs[0])
        : null;

    return { tabs, active };
  });
  const [expanded, setExpanded] = useState(initial.expanded);
  const [width, setWidth] = useState(initial.width);
  const [showDeleted, setShowDeleted] = useState(initial.showDeleted);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState<{ value: string } | null>(null);
  const [cursorAt, setCursorAt] = useState<{
    tab: string | null;
    cursor: Cursor;
  } | null>(null);
  const cursor = cursorAt?.tab === tabsState.active ? cursorAt.cursor : null;
  const [busy, setBusy] = useState(0);

  useEffect(() => {
    saveViewIn(namespace, pageKey, {
      tabs: tabsState.tabs,
      active: tabsState.active,
      expanded,
      width,
      showDeleted,
    });
  }, [namespace, pageKey, tabsState, expanded, width, showDeleted]);

  const dirty = Object.keys(drafts).length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const lists = useQueries({
    queries: roots.map((r) => ({
      queryKey: r.source.keys.list(showDeleted),
      queryFn: () => r.source.list(showDeleted),
    })),
    combine: combineResults,
  });
  const folders = useQueries({
    queries: roots.map((r) => ({
      queryKey: r.source.keys.folders(),
      queryFn: () => r.source.listFolders(),
    })),
    combine: combineResults,
  });
  const tree = useMemo(
    () =>
      buildTree(
        roots.map((root, i) => ({
          root,
          files: (lists.data[i] as StoredFile[] | undefined) ?? [],
          folders: (folders.data[i] as string[] | undefined) ?? [],
        })),
        pending,
      ),
    [roots, lists.data, folders.data, pending],
  );

  const loading = lists.pending || folders.pending;
  const loadError = lists.error ?? folders.error;

  const refreshRoot = (id: RootId) => {
    const root = rootOf(id);

    return root
      ? queryClient.invalidateQueries({ queryKey: root.source.keys.all })
      : Promise.resolve();
  };

  const setActive = (id: string) => setTabsState((s) => ({ ...s, active: id }));
  const open = (tab: Omit<TabState, "transient">, permanent: boolean) =>
    setTabsState((s) => openTab(s, tab, permanent));
  const discard = (id: string) =>
    setDrafts((d) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)),
    );
  const close = (id: string) => {
    setTabsState((s) => closeTab(s, id));
    discard(id);
  };
  const requestClose = (id: string) => {
    const tab = tabsState.tabs.find((t) => tabId(t) === id);

    if (!tab || !drafts[id]) {
      close(id);

      return;
    }

    confirmAction({
      title: `Close “${baseName(tab.key)}” without saving?`,
      message: <>Your unsaved changes to it will be lost.</>,
      confirm: "Discard changes",
      cancel: "Keep editing",
      danger: true,
      onConfirm: () => close(id),
    });
  };
  const activeTab = tabsState.tabs.find((t) => tabId(t) === tabsState.active);

  const warn = (title: string, message: string) =>
    notifications.show({ color: "yellow", title, message });

  const commitPending = async (p: Pending, name: string) => {
    setPending(null);
    const source = rootOf(p.root)?.source;

    if (!source) return;

    const path = joinPath(p.parent, name);
    const problem = fileNameProblem(path);

    if (problem) {
      warn("Could not create it", `Not a valid name: ${problem}.`);

      return;
    }

    if (
      tree.info.has(nodeValue({ root: p.root, kind: "file", path })) ||
      tree.info.has(nodeValue({ root: p.root, kind: "folder", path }))
    ) {
      warn("Could not create it", `“${path}” already exists.`);

      return;
    }

    try {
      if (p.kind === "new-folder") {
        await source.createFolder(path);
        await refreshRoot(p.root);
      } else {
        const mediaType = mediaTypeForName(path);

        await source.write(path, mediaType, emptyValueFor(mediaType));
        await refreshRoot(p.root);
        open({ kind: "file", root: p.root, key: path }, true);
      }
    } catch (err) {
      showError(
        p.kind === "new-folder"
          ? "Could not create the folder"
          : "Could not create the file",
      )(err);
    }
  };

  const commitRename = async (ref: NodeRef, name: string) => {
    setRenaming(null);
    const source = rootOf(ref.root)?.source;
    const to = joinPath(dirName(ref.path), name);

    if (!source || to === ref.path) return;

    try {
      await source.renameFolder(ref.path, to);
      await refreshRoot(ref.root);
      const before = tabsState;
      const after = renameFolderInTabs(before, ref.root, ref.path, to);
      const moved: Record<string, Draft> = {};

      before.tabs.forEach((t, i) => {
        const next = after.tabs[i];
        const draft = drafts[tabId(t)];

        if (next && draft) moved[tabId(next)] = draft;
      });
      setDrafts((d) => {
        const kept = Object.fromEntries(
          Object.entries(d).filter(
            ([id]) => !before.tabs.some((t) => tabId(t) === id),
          ),
        );

        return { ...kept, ...moved };
      });
      setTabsState(after);
    } catch (err) {
      showError("Could not rename the folder")(err);
    }
  };

  const deleteFolder = (ref: NodeRef) => {
    const source = rootOf(ref.root)?.source;

    if (!source) return;

    confirmAction({
      title: `Delete the folder “${ref.path}”?`,
      message: (
        <>
          Every file inside it is deleted too. Each file keeps its earlier
          versions and can be restored.
        </>
      ),
      confirm: "Delete",
      cancel: "Cancel",
      danger: true,
      onConfirm: () =>
        source
          .deleteFolder(ref.path)
          .then(() => refreshRoot(ref.root))
          .catch(showError("Could not delete the folder")),
    });
  };

  const deleteFile = (ref: NodeRef) => {
    const source = rootOf(ref.root)?.source;

    if (!source) return;

    confirmAction({
      title: `Delete “${ref.path}”?`,
      message: (
        <>Its earlier versions are kept, and it can be restored from them.</>
      ),
      confirm: "Delete",
      cancel: "Cancel",
      danger: true,
      onConfirm: () =>
        source
          .remove(ref.path)
          .then(() => refreshRoot(ref.root))
          .catch(showError("Could not delete the file")),
    });
  };

  const upload = async (root: RootId, folder: string, files: File[]) => {
    const source = rootOf(root)?.source;

    if (!source) return;

    const refuse = (message: string) =>
      warn("Could not upload the file", message);

    for (const file of files) {
      const label = file.name || "That file";
      const anyType = source.accepts?.anyType === true;
      const mediaType = anyType
        ? file.type || "application/octet-stream"
        : attachmentMediaType(file.name, file.type);

      if (!mediaType) {
        refuse(`${label} cannot be uploaded. Use ${ACCEPTED_DESCRIPTION}.`);
        continue;
      }

      if (!anyType && file.size > MAX_ATTACHMENT_BYTES) {
        refuse(
          `${label} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
        );
        continue;
      }

      setBusy((n) => n + 1);

      try {
        const made = await source.upload(
          file,
          mediaType,
          joinPath(folder, file.name),
        );

        await refreshRoot(root);
        open({ kind: "file", root, key: made.key }, true);
      } catch (err) {
        refuse(`${label}: ${(err as Error).message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  const activeRef: NodeRef | null = activeTab
    ? { root: activeTab.root, kind: "file", path: activeTab.key }
    : null;
  const activeInfo = activeRef
    ? tree.info.get(nodeValue(activeRef))
    : undefined;
  const activeIsText =
    activeTab?.kind === "file" &&
    activeInfo !== undefined &&
    !activeInfo.deleted &&
    (activeInfo.mediaType?.startsWith("text/") === true ||
      activeInfo.mediaType === "application/json");
  const activeDirty = activeTab
    ? drafts[tabId(activeTab)] !== undefined
    : false;
  const activeReason = activeTab ? reasons[activeTab.root] : undefined;

  const sourceOf = (t: TabState) => rootOf(t.root)?.source;

  const sidebar = loading ? (
    <Loader size="sm" m="sm" aria-label="Loading the files" />
  ) : (
    <>
      {loadError && (
        <Alert color="red" m="xs" p="xs">
          {loadError.message}
        </Alert>
      )}
      <FileTree
        data={tree.data}
        info={tree.info}
        roots={roots}
        reasons={reasons}
        pageRoot={pageRoot}
        initialExpanded={{
          ...Object.fromEntries(
            roots.map((r) => [
              nodeValue({ root: r.id, kind: "root", path: "" }),
              true,
            ]),
          ),
          ...expanded,
        }}
        onExpandedChange={setExpanded}
        activeValue={activeRef ? nodeValue(activeRef) : null}
        renaming={renaming}
        showDeleted={showDeleted}
        uploading={busy > 0}
        onToggleDeleted={() => setShowDeleted((v) => !v)}
        onOpenFile={(ref, permanent) =>
          open({ kind: "file", root: ref.root, key: ref.path }, permanent)
        }
        onStartPending={setPending}
        onCommitPending={(p, name) => void commitPending(p, name)}
        onCancelPending={() => setPending(null)}
        onStartRename={(value) => setRenaming({ value })}
        onCommitRename={(ref, name) => void commitRename(ref, name)}
        onCancelRename={() => setRenaming(null)}
        onDeleteFolder={deleteFolder}
        onDeleteFile={deleteFile}
        onUpload={(root, folder, files) => void upload(root, folder, files)}
        extraTools={extraTools}
        nodeActions={nodeActions}
      />
    </>
  );

  const colorOf = useProjectColor();
  const colorProps = (root: RootId): { iconColor?: ProjectColor } => {
    const color = colorOf(rootOf(root)?.projectId);

    return color ? { iconColor: color } : {};
  };
  const rootColorProps = (root: RootId): { rootColor?: ProjectColor } => {
    const { iconColor } = colorProps(root);

    return iconColor ? { rootColor: iconColor } : {};
  };
  const shellTabs: ShellTab[] = tabsState.tabs.map((t) => {
    const info = tree.info.get(
      nodeValue({ root: t.root, kind: "file", path: t.key }),
    );
    const name = baseName(t.key);

    return {
      id: tabId(t),
      label:
        t.kind === "preview"
          ? `Preview ${name}`
          : `${name} · ${labelOf(t.root)}`,
      title: `${labelOf(t.root)}/${t.key}`,
      icon:
        t.kind === "preview" ? (
          <IconBook size={14} />
        ) : (
          <FileIcon mediaType={info?.mediaType} size={14} />
        ),
      ...colorProps(t.root),
      transient: t.transient,
      dirty: drafts[tabId(t)] !== undefined,
    };
  });

  const content =
    activeTab && sourceOf(activeTab) ? (
      activeTab.kind === "preview" ? (
        <PreviewTab
          key={tabId(activeTab)}
          source={sourceOf(activeTab) as ExplorerSource}
          fileKey={activeTab.key}
          draft={drafts[tabId({ ...activeTab, kind: "file" })]}
        />
      ) : (
        <FileTab
          key={tabId(activeTab)}
          source={sourceOf(activeTab) as ExplorerSource}
          rootLabel={labelOf(activeTab.root)}
          {...rootColorProps(activeTab.root)}
          fileKey={activeTab.key}
          readOnly={reasons[activeTab.root]}
          broadNote={rootOf(activeTab.root)?.broadNote}
          draft={drafts[tabId(activeTab)]}
          onDraft={(draft) =>
            setDrafts((d) => {
              const id = tabId(activeTab);

              if (draft) return { ...d, [id]: draft };

              return Object.fromEntries(
                Object.entries(d).filter(([k]) => k !== id),
              );
            })
          }
          onKeep={() => setTabsState((s) => keepTab(s, tabId(activeTab)))}
          onCursor={(c) => setCursorAt({ tab: tabsState.active, cursor: c })}
          onPreview={() =>
            open(
              { kind: "preview", root: activeTab.root, key: activeTab.key },
              true,
            )
          }
        />
      )
    ) : null;

  return (
    <ExplorerShell
      width={width}
      onWidthChange={setWidth}
      sidebar={sidebar}
      tabs={shellTabs}
      active={tabsState.active}
      onActivate={setActive}
      onKeep={(id) => setTabsState((s) => keepTab(s, id))}
      onRequestClose={requestClose}
      content={content}
      empty="Open a file from the tree."
      tabListLabel="Open files"
      resizeLabel="Resize the file tree"
      statusLeft={
        activeTab
          ? `${labelOf(activeTab.root)} › ${activeTab.key.split("/").join(" › ")}`
          : "No file open"
      }
      statusRight={
        activeTab && (
          <>
            {activeIsText && cursor && (
              <Text size="xs" c="dimmed">
                Ln {cursor.line}, Col {cursor.column}
              </Text>
            )}
            {activeInfo?.mediaType && (
              <Text size="xs" c="dimmed">
                {activeInfo.mediaType}
              </Text>
            )}
            {activeTab.kind === "file" && (
              <Text size="xs" c={activeDirty ? "yellow" : "dimmed"}>
                {activeReason
                  ? "Read-only"
                  : activeDirty
                    ? "Unsaved changes"
                    : "Saved"}
              </Text>
            )}
          </>
        )
      }
    />
  );
}
