import {
  Flex,
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
import {
  INHERITED,
  TreeChevron,
  TreeIcon,
  TreeMenuAnchor,
  TreeRow,
} from "../TreeParts";
import { PaneHeader } from "../PaneHeader";
import {
  IconEye,
  IconEyeOff,
  IconFileDatabase,
  IconFilePlus,
  IconFolder,
  IconFolderOpen,
  IconLink,
  IconSchema,
  IconSquarePlus,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { MAX_DATA_NAME } from "@harness/core";
import type { DataOwner } from "../../api";
import {
  nodeValue,
  type Root,
  type RootId,
  type TreeNode,
} from "../../lib/explorer";
import {
  parseNodeValue,
  scopeName,
  type NodeInfo,
  type NodeRef,
  type Pending,
} from "../../lib/structured-explorer";

function InlineName({
  label,
  onCommit,
  onCancel,
}: {
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");

  return (
    <TextInput
      size="xs"
      autoFocus
      aria-label={label}
      flex={1}
      miw={0}
      maxLength={MAX_DATA_NAME}
      value={name}
      onChange={(e) => setName(e.currentTarget.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation();

        if (e.key === "Escape") onCancel();

        if (e.key === "Enter" && name.trim() !== "") onCommit(name.trim());
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

export const inheritedNote = (
  info: NodeInfo,
  root: Root<DataOwner>,
): string => {
  const scope = info.schemaScope;

  if (scope === "builtin") {
    return `A built-in schema that comes with the app. ${root.label} can make data from it.`;
  }

  const name = scope ? scopeName(scope) : "A higher scope";

  return `Inherited from ${name}. It is shared, so changing it changes it for everyone who uses it; ${root.label} can make data from it.`;
};

export interface StructuredTreeProps {
  data: TreeNode[];
  info: ReadonlyMap<string, NodeInfo>;
  roots: readonly Root<DataOwner>[];
  reasons: Readonly<Record<RootId, string | undefined>>;
  pageRoot: RootId;
  initialExpanded: Record<string, boolean>;
  onExpandedChange: (state: Record<string, boolean>) => void;
  activeValue: string | null;
  showDeleted: boolean;
  onToggleDeleted: () => void;
  onOpen: (ref: NodeRef, permanent: boolean) => void;
  onStartPending: (p: Pending) => void;
  onCommitPending: (p: Pending, name: string) => void;
  onCancelPending: () => void;
  onCopy: (ref: NodeRef) => void;
  onDelete: (ref: NodeRef) => void;
}

export function StructuredTree(props: StructuredTreeProps) {
  const { data, info, roots, reasons, pageRoot, showDeleted } = props;
  const tree = useTree({
    initialExpandedState: props.initialExpanded,
    onExpandedStateChange: props.onExpandedChange,
  });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    ref: NodeRef;
  } | null>(null);

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
      nodeValue({ root: ref.root, kind: "schemas", path: "" }),
    ];

    if (ref.kind === "data") {
      const parent = findParent(data, activeValue);

      if (parent) above.push(parent);
    }

    if (above.some((v) => !ctl.expandedState[v])) {
      ctl.setExpandedState({
        ...ctl.expandedState,
        ...Object.fromEntries(above.map((v) => [v, true])),
      });
    }

    ctl.setSelectedState([activeValue]);
  }, [activeValue, data]);

  const selected = tree.selectedState[0];
  const target: NodeRef = selected
    ? parseNodeValue(selected)
    : { root: pageRoot, kind: "root", path: "" };
  const locked = (root: RootId) => reasons[root] !== undefined;
  const schemaRow = (ref: NodeRef): NodeInfo | undefined =>
    ref.kind === "schema" ? info.get(nodeValue(ref)) : undefined;

  const rootOf = (id: RootId) => roots.find((r) => r.id === id);
  const startSchema = (ref: NodeRef) => {
    tree.setExpandedState({
      ...tree.expandedState,
      [nodeValue({ root: ref.root, kind: "root", path: "" })]: true,
      [nodeValue({ root: ref.root, kind: "schemas", path: "" })]: true,
    });
    props.onStartPending({ kind: "new-schema", root: ref.root });
  };
  const startData = (ref: NodeRef) => {
    if (ref.kind !== "schema") return;

    tree.setExpandedState({
      ...tree.expandedState,
      [nodeValue({ root: ref.root, kind: "root", path: "" })]: true,
      [nodeValue({ root: ref.root, kind: "schemas", path: "" })]: true,
      [nodeValue(ref)]: true,
    });
    props.onStartPending({
      kind: "new-data",
      root: ref.root,
      schemaId: ref.path,
    });
  };

  const lockReason = reasons[target.root];
  const newDataLocked =
    target.kind !== "schema"
      ? "Pick a schema to make data from."
      : lockReason !== undefined
        ? lockReason
        : info.get(nodeValue(target))?.deleted
          ? "The schema is deleted."
          : undefined;

  return (
    <Stack gap={0} flex={1} mih={0}>
      <PaneHeader title="Structured data">
        <HeaderAction
          label="New schema"
          icon={<IconSquarePlus size={16} />}
          locked={lockReason}
          onClick={() => startSchema(target)}
        />
        <HeaderAction
          label="New data"
          icon={<IconFilePlus size={16} />}
          locked={newDataLocked}
          onClick={() => startData(target)}
        />
        <Tooltip
          label={showDeleted ? "Hide deleted items" : "Show deleted items"}
          openDelay={400}
        >
          <ActionIcon
            variant={showDeleted ? "light" : "subtle"}
            color="gray"
            aria-label="Show deleted"
            aria-pressed={showDeleted}
            onClick={props.onToggleDeleted}
          >
            {showDeleted ? <IconEye size={16} /> : <IconEyeOff size={16} />}
          </ActionIcon>
        </Tooltip>
      </PaneHeader>

      <ScrollArea flex={1} mih={0}>
        <Tree
          data={data}
          tree={tree}
          levelOffset="md"
          selectOnClick
          expandOnSpace={false}
          aria-label="Structured data"
          renderNode={({ node, expanded, hasChildren, elementProps }) => {
            const ref = parseNodeValue(node.value);
            const row = info.get(node.value);

            if (ref.kind === "new-schema" || ref.kind === "new-data") {
              const p: Pending =
                ref.kind === "new-schema"
                  ? { kind: "new-schema", root: ref.root }
                  : { kind: "new-data", root: ref.root, schemaId: ref.path };

              return (
                <div
                  className={elementProps.className}
                  // eslint-disable-next-line no-restricted-syntax -- replaces the indentation in elementProps.style
                  style={{ ...elementProps.style, padding: "2px 8px" }}
                >
                  <InlineName
                    label={
                      ref.kind === "new-schema"
                        ? "New schema name"
                        : "New data name"
                    }
                    onCommit={(name) => props.onCommitPending(p, name)}
                    onCancel={props.onCancelPending}
                  />
                </div>
              );
            }

            const isFolder =
              ref.kind === "root" ||
              ref.kind === "schemas" ||
              ref.kind === "unknown";
            const deleted = row?.deleted ?? false;
            const inherited = row?.inherited === true;
            const openable = ref.kind === "schema" || ref.kind === "data";
            const nameColor = inherited ? INHERITED : undefined;
            const root = rootOf(ref.root);
            const label = (
              <Text
                size="sm"
                truncate
                fw={ref.kind === "root" ? 600 : undefined}
                td={deleted ? "line-through" : undefined}
                {...(nameColor ? { c: nameColor } : {})}
                flex={1}
                miw={0}
              >
                {node.label}
              </Text>
            );

            return (
              <TreeRow
                elementProps={elementProps}
                deleted={deleted}
                onClick={(e) => {
                  elementProps.onClick(e);

                  if (openable) props.onOpen(ref, false);
                }}
                onDoubleClick={() => {
                  if (openable) props.onOpen(ref, true);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  tree.setSelectedState([node.value]);
                  setMenu({ x: e.clientX, y: e.clientY, ref });
                }}
              >
                <TreeChevron show={hasChildren} expanded={expanded} />
                <TreeIcon inherited={inherited}>
                  {isFolder ? (
                    expanded && hasChildren ? (
                      <IconFolderOpen size={16} />
                    ) : (
                      <IconFolder size={16} />
                    )
                  ) : ref.kind === "schema" ? (
                    inherited ? (
                      <IconLink size={16} aria-label="Inherited schema" />
                    ) : (
                      <IconSchema size={16} />
                    )
                  ) : (
                    <IconFileDatabase size={16} />
                  )}
                </TreeIcon>
                {inherited && row && root ? (
                  <Tooltip
                    label={inheritedNote(row, root)}
                    multiline
                    w={260}
                    openDelay={300}
                    position="right"
                    withinPortal
                  >
                    <Flex
                      component="span"
                      flex={1}
                      miw={0}
                      data-testid="inherited-schema"
                    >
                      {label}
                    </Flex>
                  </Tooltip>
                ) : (
                  label
                )}
                {ref.kind === "data" && row?.outOfDate && (
                  <Tooltip label="Out of date: its schema has a newer version.">
                    <Text size="xs" c="yellow" aria-label="Out of date">
                      !
                    </Text>
                  </Tooltip>
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
              row={info.get(nodeValue(menu.ref))}
              schema={schemaRow(menu.ref)}
              locked={locked(menu.ref.root)}
              onOpen={() => props.onOpen(menu.ref, true)}
              onNewSchema={() => startSchema(menu.ref)}
              onNewData={() => startData(menu.ref)}
              onCopy={() => props.onCopy(menu.ref)}
              onDelete={() => props.onDelete(menu.ref)}
            />
          )}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}

function findParent(nodes: readonly TreeNode[], value: string): string | null {
  for (const n of nodes) {
    if (n.children?.some((c) => c.value === value)) return n.value;

    const deeper = n.children ? findParent(n.children, value) : null;

    if (deeper) return deeper;
  }

  return null;
}

function TreeMenu({
  menuRef,
  row,
  schema,
  locked,
  onOpen,
  onNewSchema,
  onNewData,
  onCopy,
  onDelete,
}: {
  menuRef: NodeRef;
  row: NodeInfo | undefined;
  schema: NodeInfo | undefined;
  locked: boolean;
  onOpen: () => void;
  onNewSchema: () => void;
  onNewData: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  if (menuRef.kind === "data") {
    return (
      <>
        <Menu.Item onClick={onOpen}>Open</Menu.Item>
        {!locked && !row?.deleted && (
          <Menu.Item color="red" onClick={onDelete}>
            Delete
          </Menu.Item>
        )}
      </>
    );
  }

  if (menuRef.kind === "schema") {
    const own = schema?.inherited !== true && schema?.schemaScope !== "builtin";

    return (
      <>
        <Menu.Item onClick={onOpen}>Open</Menu.Item>
        {!locked && !row?.deleted && (
          <Menu.Item onClick={onNewData}>New data here</Menu.Item>
        )}
        {!row?.deleted && <Menu.Item onClick={onCopy}>Copy to…</Menu.Item>}
        {!locked && own && !row?.deleted && (
          <>
            <Menu.Divider />
            <Menu.Item color="red" onClick={onDelete}>
              Delete schema
            </Menu.Item>
          </>
        )}
      </>
    );
  }

  if (menuRef.kind === "unknown") {
    return <Menu.Label>Its schema is not available here.</Menu.Label>;
  }

  if (locked) {
    return <Menu.Label>This cannot be changed right now.</Menu.Label>;
  }

  return <Menu.Item onClick={onNewSchema}>New schema here</Menu.Item>;
}
