import {
  ActionIcon,
  Menu,
  ScrollArea,
  Text,
  TextInput,
  Tooltip,
  Tree,
  useTree,
  Stack,
} from "@mantine/core";
import { TreeChevron, TreeMenuAnchor, TreeRow, TreeIcon } from "../TreeParts";
import { PaneHeader } from "../PaneHeader";
import {
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
      flex={1}
      miw={0}
      value={name}
      error={problem}
      onChange={(e) => setName(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && name !== "" && !problem) onCommit(name);
      }}
    />
  );
}

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
        color="gray"
        aria-label={label}
        disabled={locked !== undefined}
        onClick={onClick}
      >
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}

const folderOf = (ref: NodeRef): string =>
  ref.kind === "file" ? dirName(ref.path) : ref.path;

export interface NodeAction {
  label: string;
  onClick: () => void;
}

export interface FileTreeProps {
  data: TreeNode[];
  info: ReadonlyMap<string, NodeInfo>;
  roots: readonly Pick<Root, "id" | "label">[];
  reasons: Readonly<Record<RootId, string | undefined>>;
  pageRoot: RootId;
  initialExpanded: Record<string, boolean>;
  onExpandedChange: (state: Record<string, boolean>) => void;
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
  extraTools?: React.ReactNode;
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
  const pickFor = useRef<{ root: RootId; folder: string }>({
    root: pageRoot,
    folder: "",
  });

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
    <Stack gap={0} flex={1} mih={0}>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        aria-label="Choose files to upload"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length > 0)
            props.onUpload(pickFor.current.root, pickFor.current.folder, files);
        }}
      />
      <PaneHeader title="Explorer">
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
            aria-label="Show deleted files"
            aria-pressed={showDeleted}
            onClick={props.onToggleDeleted}
          >
            {showDeleted ? <IconEye size={16} /> : <IconEyeOff size={16} />}
          </ActionIcon>
        </Tooltip>
      </PaneHeader>

      <ScrollArea
        flex={1}
        mih={0}
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
                  // eslint-disable-next-line no-restricted-syntax -- replaces the indentation in elementProps.style
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
              <TreeRow
                elementProps={elementProps}
                title={ref.path === "" ? undefined : ref.path}
                deleted={deleted}
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
                <TreeChevron
                  show={isFolder && hasChildren}
                  expanded={expanded}
                />
                <TreeIcon>
                  {isFolder ? (
                    expanded && hasChildren ? (
                      <IconFolderOpen size={16} />
                    ) : (
                      <IconFolder size={16} />
                    )
                  ) : (
                    <FileIcon mediaType={row?.mediaType} />
                  )}
                </TreeIcon>
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
                    flex={1}
                    miw={0}
                  >
                    {node.label}
                  </Text>
                )}
              </TreeRow>
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
          <TreeMenuAnchor menu={menu} />
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
    </Stack>
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
