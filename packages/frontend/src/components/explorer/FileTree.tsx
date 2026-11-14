import {
  ActionIcon,
  Box,
  Menu,
  ScrollArea,
  Text,
  TextInput,
  Tooltip,
  Tree,
  useTree,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconMarkdown,
  IconJson,
  IconMusic,
  IconPhoto,
  IconUpload,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { mediaKindOf, parentFolders, type MediaType } from "@harness/core";
import {
  dirName,
  nodeValue,
  parseNodeValue,
  type NodeInfo,
  type NodeRef,
  type Pending,
  type Root,
  type RootId,
  type TreeNode,
} from "../../lib/files-explorer";
import { ACCEPT } from "../../lib/attachments";
import { nameError } from "./FileViews";

/*
 * The explorer of the Files view: one tree with a root folder for each
 * place files live (Session, Project, Global), a header with the actions,
 * a right-click menu, and inline name boxes for new files and folders and
 * for renaming a folder. It holds no data of its own; the parent gives it
 * the tree and does what the actions ask.
 */

export function FileIcon({
  mediaType,
  size = 16,
}: {
  mediaType?: MediaType | undefined;
  size?: number;
}) {
  const kind = mediaType ? mediaKindOf(mediaType) : undefined;
  if (kind === "image") return <IconPhoto size={size} />;
  if (kind === "audio") return <IconMusic size={size} />;
  if (mediaType === "text/markdown") return <IconMarkdown size={size} />;
  if (mediaType === "application/json") return <IconJson size={size} />;
  return <IconFile size={size} />;
}

/** A name box in the tree: Enter accepts, Escape or leaving it cancels. */
function InlineName({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const problem = name === "" ? undefined : nameError(name);
  return (
    <TextInput
      size="xs"
      autoFocus
      aria-label={label}
      style={{ flex: 1, minWidth: 0 }}
      value={name}
      error={problem}
      onChange={(e) => setName(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onCancel}
      // The tree item reads Space and the arrow keys; they are for typing here.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && name !== "" && !problem) onCommit(name);
      }}
    />
  );
}

/** A button of the explorer's header; `locked` is the reason it is off. */
function HeaderAction({
  label,
  icon,
  locked,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  locked: string | undefined;
  onClick: () => void;
}) {
  return (
    <Tooltip label={locked ? locked : label} openDelay={400}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        disabled={locked !== undefined}
        onClick={onClick}
      >
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}

/** The folder an action on a node applies to. */
const folderOf = (ref: NodeRef): string =>
  ref.kind === "file" ? dirName(ref.path) : ref.path;

/** An extra entry in a node's menu, added by the explorer's owner. */
export interface NodeAction {
  label: string;
  onClick: () => void;
}

export interface FileTreeProps {
  data: TreeNode[];
  info: ReadonlyMap<string, NodeInfo>;
  roots: readonly Pick<Root, "id" | "label">[];
  /** Why a root cannot be changed, when it cannot. */
  reasons: Readonly<Record<RootId, string | undefined>>;
  /** The root actions go to when nothing is selected: the page's own. */
  pageRoot: RootId;
  initialExpanded: Record<string, boolean>;
  onExpandedChange: (state: Record<string, boolean>) => void;
  /** The value of the file shown in the active tab, to select it. */
  activeValue: string | null;
  renaming: { value: string } | null;
  showDeleted: boolean;
  uploading: boolean;
  onToggleDeleted: () => void;
  onOpenFile: (ref: NodeRef, permanent: boolean) => void;
  onStartPending: (p: Pending) => void;
  onCommitPending: (p: Pending, name: string) => void;
  onCancelPending: () => void;
  onStartRename: (value: string) => void;
  onCommitRename: (ref: NodeRef, name: string) => void;
  onCancelRename: () => void;
  onDeleteFolder: (ref: NodeRef) => void;
  onDeleteFile: (ref: NodeRef) => void;
  onUpload: (root: RootId, folder: string, files: File[]) => void;
  /** Extra header buttons, after the usual ones (skills: Import). */
  extraTools?: React.ReactNode;
  /** Extra menu entries for a node (skills: Export). Shown even when locked. */
  nodeActions?: ((ref: NodeRef) => NodeAction[]) | undefined;
}

export function FileTree(props: FileTreeProps) {
  const { data, info, reasons, pageRoot, renaming, showDeleted, uploading } =
    props;
  const tree = useTree({
    initialExpandedState: props.initialExpanded,
    onExpandedStateChange: props.onExpandedChange,
  });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    ref: NodeRef;
  } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Where the file picker's files go.
  const pickFor = useRef<{ root: RootId; folder: string }>({
    root: pageRoot,
    folder: "",
  });

  // The file in the active tab is the selected row, and its folders are
  // opened so it can be seen, as in an editor. The controller is held in a
  // ref: its functions change with every render.
  const controller = useRef(tree);
  useEffect(() => {
    controller.current = tree;
  });
  const { activeValue } = props;
  useEffect(() => {
    if (!activeValue) return;
    const ctl = controller.current;
    const ref = parseNodeValue(activeValue);
    const above = [
      nodeValue({ root: ref.root, kind: "root", path: "" }),
      ...parentFolders(ref.path).map((path) =>
        nodeValue({ root: ref.root, kind: "folder", path }),
      ),
    ];
    if (above.some((v) => !ctl.expandedState[v])) {
      ctl.setExpandedState({
        ...ctl.expandedState,
        ...Object.fromEntries(above.map((v) => [v, true])),
      });
    }
    ctl.setSelectedState([activeValue]);
  }, [activeValue]);

  const selected = tree.selectedState[0];
  const target: NodeRef = selected
    ? parseNodeValue(selected)
    : { root: pageRoot, kind: "root", path: "" };
  const locked = (root: RootId) => reasons[root] !== undefined;

  const startPending = (kind: Pending["kind"], ref: NodeRef) => {
    const parent = folderOf(ref);
    // Open the folder so the name box shows (one update: two would each
    // start from the same state, and the second would undo the first).
    tree.setExpandedState({
      ...tree.expandedState,
      [nodeValue({ root: ref.root, kind: "root", path: "" })]: true,
      ...(parent === ""
        ? {}
        : {
            [nodeValue({ root: ref.root, kind: "folder", path: parent })]: true,
          }),
    });
    props.onStartPending({ kind, root: ref.root, parent });
  };
  const chooseFiles = (ref: NodeRef) => {
    pickFor.current = { root: ref.root, folder: folderOf(ref) };
    picker.current?.click();
  };

  const acceptsDrop = (e: React.DragEvent, root: RootId) =>
    !locked(root) && e.dataTransfer.types.includes("Files");
  const drop = (e: React.DragEvent, root: RootId, folder: string) => {
    if (locked(root) || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    props.onUpload(root, folder, Array.from(e.dataTransfer.files));
  };

  const targetLocked = locked(target.root);
  const lockReason = reasons[target.root];

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        aria-label="Choose files to upload"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // So choosing the same file again is noticed.
          e.currentTarget.value = "";
          if (files.length > 0)
            props.onUpload(pickFor.current.root, pickFor.current.folder, files);
        }}
      />
      <Box
        px="xs"
        py={4}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Text
          size="xs"
          fw={600}
          c="dimmed"
          tt="uppercase"
          style={{ letterSpacing: 0.5 }}
        >
          Explorer
        </Text>
        <Box style={{ display: "flex", gap: 2 }}>
          <HeaderAction
            label="New file"
            icon={<IconFilePlus size={16} />}
            locked={targetLocked ? (lockReason ?? "") : undefined}
            onClick={() => startPending("new-file", target)}
          />
          <HeaderAction
            label="New folder"
            icon={<IconFolderPlus size={16} />}
            locked={targetLocked ? (lockReason ?? "") : undefined}
            onClick={() => startPending("new-folder", target)}
          />
          <HeaderAction
            label={uploading ? "Uploading…" : "Upload"}
            icon={<IconUpload size={16} />}
            locked={targetLocked ? (lockReason ?? "") : undefined}
            onClick={() => chooseFiles(target)}
          />
          {props.extraTools}
          <Tooltip
            label={showDeleted ? "Hide deleted files" : "Show deleted files"}
            openDelay={400}
          >
            <ActionIcon
              variant={showDeleted ? "light" : "subtle"}
              color="gray"
              size="sm"
              aria-label="Show deleted files"
              aria-pressed={showDeleted}
              onClick={props.onToggleDeleted}
            >
              {showDeleted ? <IconEye size={16} /> : <IconEyeOff size={16} />}
            </ActionIcon>
          </Tooltip>
        </Box>
      </Box>

      <ScrollArea
        style={{ flex: 1, minHeight: 0 }}
        // Files dropped on empty space go to the page's own root.
        onDragOver={(e: React.DragEvent) => {
          if (acceptsDrop(e, pageRoot)) e.preventDefault();
        }}
        onDrop={(e: React.DragEvent) => drop(e, pageRoot, "")}
      >
        <Tree
          data={data}
          tree={tree}
          levelOffset="md"
          selectOnClick
          expandOnSpace={false}
          aria-label="Files"
          renderNode={({ node, expanded, hasChildren, elementProps }) => {
            const ref = parseNodeValue(node.value);
            const row = info.get(node.value);
            if (ref.kind === "new-file" || ref.kind === "new-folder") {
              const p: Pending = {
                kind: ref.kind,
                root: ref.root,
                parent: ref.path,
              };
              return (
                <div
                  className={elementProps.className}
                  style={{ ...elementProps.style, padding: "2px 8px" }}
                >
                  <InlineName
                    initial=""
                    label={
                      ref.kind === "new-file"
                        ? "New file name"
                        : "New folder name"
                    }
                    onCommit={(name) => props.onCommitPending(p, name)}
                    onCancel={props.onCancelPending}
                  />
                </div>
              );
            }
            const isFolder = ref.kind === "folder" || ref.kind === "root";
            const isRenaming = renaming?.value === node.value;
            const deleted = row?.deleted ?? false;
            return (
              <div
                {...elementProps}
                title={ref.path === "" ? undefined : ref.path}
                style={{
                  ...elementProps.style,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingBlock: 3,
                  paddingInlineEnd: 8,
                  cursor: "pointer",
                  userSelect: "none",
                  opacity: deleted ? 0.6 : 1,
                }}
                onClick={(e) => {
                  elementProps.onClick(e);
                  if (ref.kind === "file") props.onOpenFile(ref, false);
                }}
                onDoubleClick={() => {
                  if (ref.kind === "file") props.onOpenFile(ref, true);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  tree.setSelectedState([node.value]);
                  setMenu({ x: e.clientX, y: e.clientY, ref });
                }}
                onDragOver={(e) => {
                  if (acceptsDrop(e, ref.root)) e.preventDefault();
                }}
                onDrop={(e) => drop(e, ref.root, folderOf(ref))}
              >
                <span
                  style={{
                    width: 14,
                    display: "inline-flex",
                    flexShrink: 0,
                    color: "var(--mantine-color-dimmed)",
                  }}
                >
                  {isFolder && hasChildren ? (
                    expanded ? (
                      <IconChevronDown size={14} />
                    ) : (
                      <IconChevronRight size={14} />
                    )
                  ) : null}
                </span>
                <span style={{ display: "inline-flex", flexShrink: 0 }}>
                  {isFolder ? (
                    expanded && hasChildren ? (
                      <IconFolderOpen size={16} />
                    ) : (
                      <IconFolder size={16} />
                    )
                  ) : (
                    <FileIcon mediaType={row?.mediaType} />
                  )}
                </span>
                {isRenaming ? (
                  <InlineName
                    initial={row?.name ?? ""}
                    label={`New name for ${row?.name ?? "the folder"}`}
                    onCommit={(name) => props.onCommitRename(ref, name)}
                    onCancel={props.onCancelRename}
                  />
                ) : (
                  <Text
                    size="sm"
                    truncate
                    fw={ref.kind === "root" ? 600 : undefined}
                    td={deleted ? "line-through" : undefined}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {node.label}
                  </Text>
                )}
              </div>
            );
          }}
        />
      </ScrollArea>

      <Menu
        opened={menu !== null}
        onChange={(open) => {
          if (!open) setMenu(null);
        }}
        position="bottom-start"
        withinPortal
      >
        <Menu.Target>
          <span
            style={{
              position: "fixed",
              left: menu?.x ?? 0,
              top: menu?.y ?? 0,
              width: 0,
              height: 0,
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          {menu && (
            <TreeMenu
              menuRef={menu.ref}
              locked={locked(menu.ref.root)}
              onNewFile={() => startPending("new-file", menu.ref)}
              onNewFolder={() => startPending("new-folder", menu.ref)}
              onUpload={() => chooseFiles(menu.ref)}
              onOpen={() => props.onOpenFile(menu.ref, true)}
              onRename={() => props.onStartRename(nodeValue(menu.ref))}
              onDeleteFolder={() => props.onDeleteFolder(menu.ref)}
              onDeleteFile={() => props.onDeleteFile(menu.ref)}
              deleted={info.get(nodeValue(menu.ref))?.deleted ?? false}
              extra={props.nodeActions?.(menu.ref) ?? []}
            />
          )}
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}

function TreeMenu({
  menuRef,
  locked,
  deleted,
  onNewFile,
  onNewFolder,
  onUpload,
  onOpen,
  onRename,
  onDeleteFolder,
  onDeleteFile,
  extra,
}: {
  extra: NodeAction[];
  menuRef: NodeRef;
  locked: boolean;
  deleted: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDeleteFolder: () => void;
  onDeleteFile: () => void;
}) {
  const extras = extra.map((a) => (
    <Menu.Item key={a.label} onClick={a.onClick}>
      {a.label}
    </Menu.Item>
  ));
  if (menuRef.kind === "file") {
    return (
      <>
        <Menu.Item onClick={onOpen}>Open</Menu.Item>
        {extras}
        {!locked && !deleted && (
          <Menu.Item color="red" onClick={onDeleteFile}>
            Delete
          </Menu.Item>
        )}
      </>
    );
  }
  if (locked) {
    return (
      <>
        <Menu.Label>This folder cannot be changed right now.</Menu.Label>
        {extras}
      </>
    );
  }
  return (
    <>
      {extras}
      <Menu.Item onClick={onNewFile}>New file here</Menu.Item>
      <Menu.Item onClick={onNewFolder}>New folder here</Menu.Item>
      <Menu.Item onClick={onUpload}>Upload here</Menu.Item>
      {menuRef.kind === "folder" && (
        <>
          <Menu.Divider />
          <Menu.Item onClick={onRename}>Rename folder</Menu.Item>
          <Menu.Item color="red" onClick={onDeleteFolder}>
            Delete folder
          </Menu.Item>
        </>
      )}
    </>
  );
}
