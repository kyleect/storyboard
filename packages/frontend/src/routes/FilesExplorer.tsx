import { Alert, Box, Loader, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconBook, IconX } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileNameProblem, joinPath } from "@harness/core";
import { api, type Entry, type EntryScope } from "../api";
import {
  ACCEPTED_DESCRIPTION,
  attachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from "../attachments";
import {
  baseName,
  buildTree,
  clampWidth,
  closeTab,
  dirName,
  emptyValueFor,
  isHigherScope,
  keepTab,
  loadView,
  mediaTypeForName,
  nodeValue,
  openTab,
  renameFolderInTabs,
  rootLabel,
  rootsFor,
  saveView,
  tabId,
  type NodeRef,
  type Pending,
  type RootId,
  type TabState,
} from "../files-explorer";
import { entryKeys } from "../queries";
import { FileIcon, FileTree } from "./FileTree";
import { FileTab, PreviewTab, type Draft } from "./FileTab";
import { showError } from "./SessionActions";
import type { Cursor } from "./TextEditor";

/*
 * The Files view: an editor-style explorer. A tree on the left has a root
 * folder for each place files live that the page can see (a session sees
 * Session, Project and Global; a project, Project and Global; the global
 * page, Global); open files are tabs on the right, edited in place.
 * Kylee's decisions of 2026-11-11 (see the plan); the rules for roots, the
 * tree and the tabs are in `files-explorer.ts`.
 */

const BORDER = "var(--mantine-color-default-border)";

/** Lists and folders of every root, as one stable value each. */
const combineResults = (
  results: { data: unknown; error: Error | null; isPending: boolean }[],
) => ({
  data: results.map((r) => r.data),
  error: results.find((r) => r.error)?.error ?? null,
  pending: results.some((r) => r.isPending),
});

export function FilesExplorer({
  page,
  projectId,
  readOnly,
  projectReadOnly,
  onDirtyChange,
}: {
  /** The scope of the page: where its own files live. */
  page: EntryScope;
  /** The session's project, if it has one. */
  projectId?: string | null | undefined;
  /** Why no root can be changed, when that is so. */
  readOnly?: string | undefined;
  /** Why the project's files cannot be changed, when that is so. */
  projectReadOnly?: string | undefined;
  /** Whether there are unsaved edits, for a guard against leaving. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  // Callers may pass a new object each render; everything below depends on
  // this one, which changes only with the page.
  const pageScope = page.scope;
  const pageId = "id" in page ? page.id : "";
  const stablePage = useMemo<EntryScope>(
    () =>
      pageScope === "global"
        ? { scope: "global" }
        : { scope: pageScope, id: pageId },
    [pageScope, pageId],
  );
  const roots = useMemo(
    () => rootsFor(stablePage, projectId),
    [stablePage, projectId],
  );
  const rootScope = (id: RootId): EntryScope | undefined =>
    roots.find((r) => r.id === id)?.scope;
  const pageRoot: RootId = pageScope;

  const reasons: Record<RootId, string | undefined> = {
    session: readOnly,
    project: readOnly ?? projectReadOnly,
    global: readOnly,
  };

  const [initial] = useState(() => loadView(stablePage));
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
  // The cursor, with the tab it was reported for: another tab has none yet.
  const [cursorAt, setCursorAt] = useState<{
    tab: string | null;
    cursor: Cursor;
  } | null>(null);
  const cursor = cursorAt?.tab === tabsState.active ? cursorAt.cursor : null;
  const [busy, setBusy] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  // What is remembered between visits (not the unsaved text).
  useEffect(() => {
    saveView(stablePage, {
      tabs: tabsState.tabs,
      active: tabsState.active,
      expanded,
      width,
      showDeleted,
    });
  }, [stablePage, tabsState, expanded, width, showDeleted]);

  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // ---- data: the files and folders of every root
  const lists = useQueries({
    queries: roots.map((r) => ({
      queryKey: entryKeys.list(r.scope, "file", showDeleted),
      queryFn: () => api.listEntries(r.scope, "file", showDeleted),
    })),
    combine: combineResults,
  });
  const folders = useQueries({
    queries: roots.map((r) => ({
      queryKey: entryKeys.folders(r.scope),
      queryFn: () => api.listFolders(r.scope),
    })),
    combine: combineResults,
  });
  const tree = useMemo(
    () =>
      buildTree(
        roots.map((root, i) => ({
          root,
          files: (lists.data[i] as Entry[] | undefined) ?? [],
          folders: (folders.data[i] as string[] | undefined) ?? [],
        })),
        pending,
      ),
    [roots, lists.data, folders.data, pending],
  );

  // The tree is made once the files are known, so the folders remembered as
  // open are still known to it when its nodes appear.
  const loading = lists.pending || folders.pending;
  const loadError = lists.error ?? folders.error;

  const refreshRoot = (id: RootId) => {
    const scope = rootScope(id);
    return scope
      ? queryClient.invalidateQueries({ queryKey: entryKeys.inScope(scope) })
      : Promise.resolve();
  };

  // ---- tabs
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
    modals.openConfirmModal({
      title: `Close “${baseName(tab.key)}” without saving?`,
      children: <Text size="sm">Your unsaved changes to it will be lost.</Text>,
      labels: { confirm: "Discard changes", cancel: "Keep editing" },
      confirmProps: { color: "red" },
      onConfirm: () => close(id),
    });
  };
  const activeTab = tabsState.tabs.find((t) => tabId(t) === tabsState.active);

  // ---- actions from the tree
  const warn = (title: string, message: string) =>
    notifications.show({ color: "yellow", title, message });

  const commitPending = async (p: Pending, name: string) => {
    setPending(null);
    const scope = rootScope(p.root);
    if (!scope) return;
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
        await api.createFolder(scope, path);
        await refreshRoot(p.root);
      } else {
        const mediaType = mediaTypeForName(path);
        await api.writeFile(scope, path, mediaType, emptyValueFor(mediaType));
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
    const scope = rootScope(ref.root);
    const to = joinPath(dirName(ref.path), name);
    if (!scope || to === ref.path) return;
    try {
      await api.renameFolder(scope, ref.path, to);
      await refreshRoot(ref.root);
      const before = tabsState;
      const after = renameFolderInTabs(before, ref.root, ref.path, to);
      // Unsaved text follows its file to the new name.
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
    const scope = rootScope(ref.root);
    if (!scope) return;
    modals.openConfirmModal({
      title: `Delete the folder “${ref.path}”?`,
      children: (
        <Text size="sm">
          Every file inside it is deleted too. Each file keeps its earlier
          versions and can be restored.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        api
          .deleteFolder(scope, ref.path)
          .then(() => refreshRoot(ref.root))
          .catch(showError("Could not delete the folder")),
    });
  };

  const deleteFile = (ref: NodeRef) => {
    const scope = rootScope(ref.root);
    if (!scope) return;
    modals.openConfirmModal({
      title: `Delete “${ref.path}”?`,
      children: (
        <Text size="sm">
          Its earlier versions are kept, and it can be restored from them.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        api
          .deleteEntry(scope, "file", ref.path)
          .then(() => refreshRoot(ref.root))
          .catch(showError("Could not delete the file")),
    });
  };

  const upload = async (root: RootId, folder: string, files: File[]) => {
    const scope = rootScope(root);
    if (!scope) return;
    const refuse = (message: string) =>
      warn("Could not upload the file", message);
    for (const file of files) {
      const label = file.name || "That file";
      const mediaType = attachmentMediaType(file.name, file.type);
      if (!mediaType) {
        refuse(`${label} cannot be uploaded. Use ${ACCEPTED_DESCRIPTION}.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        refuse(
          `${label} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
        );
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const made = await api.uploadFile(scope, file, mediaType, {
          name: joinPath(folder, file.name),
        });
        await refreshRoot(root);
        open({ kind: "file", root, key: made.key }, true);
      } catch (err) {
        refuse(`${label}: ${(err as Error).message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  // ---- the divider between the tree and the tabs
  const dragging = useRef(false);
  const resizeTo = (clientX: number) => {
    const left = container.current?.getBoundingClientRect().left ?? 0;
    setWidth(clampWidth(clientX - left));
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

  const scopeOf = (t: TabState) => rootScope(t.root);

  return (
    <Box
      ref={container}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        border: `1px solid ${BORDER}`,
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--mantine-color-body)",
      }}
    >
      <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box
          style={{
            width,
            flexShrink: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background:
              "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
          }}
        >
          {loading ? (
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
                  open(
                    { kind: "file", root: ref.root, key: ref.path },
                    permanent,
                  )
                }
                onStartPending={setPending}
                onCommitPending={(p, name) => void commitPending(p, name)}
                onCancelPending={() => setPending(null)}
                onStartRename={(value) => setRenaming({ value })}
                onCommitRename={(ref, name) => void commitRename(ref, name)}
                onCancelRename={() => setRenaming(null)}
                onDeleteFolder={deleteFolder}
                onDeleteFile={deleteFile}
                onUpload={(root, folder, files) =>
                  void upload(root, folder, files)
                }
              />
            </>
          )}
        </Box>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the file tree"
          aria-valuenow={width}
          tabIndex={0}
          style={{
            width: 5,
            flexShrink: 0,
            cursor: "col-resize",
            background: BORDER,
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragging.current) resizeTo(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWidth((w) => clampWidth(w - 16));
            if (e.key === "ArrowRight") setWidth((w) => clampWidth(w + 16));
          }}
        />

        <Box
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box
            role="tablist"
            aria-label="Open files"
            style={{
              display: "flex",
              overflowX: "auto",
              flexShrink: 0,
              minHeight: 34,
              borderBottom: `1px solid ${BORDER}`,
              background:
                "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
            }}
          >
            {tabsState.tabs.map((t) => {
              const id = tabId(t);
              const active = id === tabsState.active;
              const info = tree.info.get(
                nodeValue({ root: t.root, kind: "file", path: t.key }),
              );
              const name = baseName(t.key);
              const label =
                t.kind === "preview"
                  ? `Preview ${name}`
                  : `${name} · ${rootLabel(t.root)}`;
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  title={`${rootLabel(t.root)}/${t.key}`}
                  onClick={() => setActive(id)}
                  onDoubleClick={() => setTabsState((s) => keepTab(s, id))}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      requestClose(id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setActive(id);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px 0 10px",
                    flexShrink: 0,
                    maxWidth: 240,
                    cursor: "pointer",
                    fontSize: 13,
                    fontStyle: t.transient ? "italic" : undefined,
                    borderRight: `1px solid ${BORDER}`,
                    borderTop: `2px solid ${active ? "var(--mantine-primary-color-filled)" : "transparent"}`,
                    background: active
                      ? "var(--mantine-color-body)"
                      : undefined,
                    color: active ? undefined : "var(--mantine-color-dimmed)",
                  }}
                >
                  {t.kind === "preview" ? (
                    <IconBook size={14} />
                  ) : (
                    <FileIcon mediaType={info?.mediaType} size={14} />
                  )}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(id);
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                    }}
                  >
                    {drafts[id] ? (
                      <span
                        role="img"
                        aria-label="Unsaved changes"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "currentColor",
                        }}
                      />
                    ) : (
                      <IconX size={14} />
                    )}
                  </button>
                </div>
              );
            })}
          </Box>

          <Box style={{ flex: 1, minHeight: 0 }}>
            {activeTab && scopeOf(activeTab) ? (
              activeTab.kind === "preview" ? (
                <PreviewTab
                  key={tabId(activeTab)}
                  scope={scopeOf(activeTab) as EntryScope}
                  fileKey={activeTab.key}
                  draft={drafts[tabId({ ...activeTab, kind: "file" })]}
                />
              ) : (
                <FileTab
                  key={tabId(activeTab)}
                  scope={scopeOf(activeTab) as EntryScope}
                  root={activeTab.root}
                  fileKey={activeTab.key}
                  readOnly={reasons[activeTab.root]}
                  higher={isHigherScope(
                    scopeOf(activeTab) as EntryScope,
                    stablePage,
                  )}
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
                  onKeep={() =>
                    setTabsState((s) => keepTab(s, tabId(activeTab)))
                  }
                  onCursor={(c) =>
                    setCursorAt({ tab: tabsState.active, cursor: c })
                  }
                  onPreview={() =>
                    open(
                      {
                        kind: "preview",
                        root: activeTab.root,
                        key: activeTab.key,
                      },
                      true,
                    )
                  }
                />
              )
            ) : (
              <Box
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text size="sm" c="dimmed">
                  Open a file from the tree.
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      <Box
        role="status"
        px="sm"
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexShrink: 0,
          minHeight: 24,
          alignItems: "center",
          borderTop: `1px solid ${BORDER}`,
          background:
            "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
        }}
      >
        <Text size="xs" c="dimmed" truncate>
          {activeTab
            ? `${rootLabel(activeTab.root)} › ${activeTab.key.split("/").join(" › ")}`
            : "No file open"}
        </Text>
        <Box style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          {activeTab && (
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
          )}
        </Box>
      </Box>
    </Box>
  );
}
