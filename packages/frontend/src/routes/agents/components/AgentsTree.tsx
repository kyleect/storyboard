import {
  ActionIcon,
  Badge,
  Group,
  Menu,
  ScrollArea,
  Text,
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
} from "../../../components/TreeParts";
import { PaneHeader } from "../../../components/PaneHeader";
import {
  IconBolt,
  IconCircle,
  IconCircleCheck,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileDatabase,
  IconFolder,
  IconFolderOpen,
  IconLink,
  IconLock,
  IconRobot,
  IconSchema,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TreeNode } from "../../../lib/explorer";
import {
  parseNodeValue,
  type NodeInfo,
  type NodeRef,
} from "../lib/agents-explorer";

export interface TreeAction {
  label: string;
  onClick: () => void;
  color?: string;
}

const FOLDERS = new Set([
  "root",
  "skills",
  "skillgroup",
  "skill",
  "dir",
  "schemas",
  "schemagroup",
  "unknown",
]);
const OPENABLE = new Set(["agent", "file", "schema", "data"]);

export interface AgentsTreeProps {
  data: TreeNode[];
  info: ReadonlyMap<string, NodeInfo>;
  initialExpanded: Record<string, boolean>;
  onExpandedChange: (state: Record<string, boolean>) => void;
  activeValue: string | null;
  showDeleted: boolean;
  onToggleDeleted: () => void;
  onOpen: (ref: NodeRef, permanent: boolean) => void;
  actionsFor: (ref: NodeRef) => TreeAction[];
  header: ReactNode;
  defaultId: string | null;
  defaultLocked: string | undefined;
  onSetDefault: (agentId: string | null) => void;
}

export function AgentsTree(props: AgentsTreeProps) {
  const { data, info, showDeleted } = props;
  const tree = useTree({
    initialExpandedState: props.initialExpanded,
    onExpandedStateChange: props.onExpandedChange,
  });
  const [near, setNear] = useState<string | null>(null);
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
    const above = ancestors(data, activeValue);

    if (above.some((v) => !ctl.expandedState[v])) {
      ctl.setExpandedState({
        ...ctl.expandedState,
        ...Object.fromEntries(above.map((v) => [v, true])),
      });
    }

    ctl.setSelectedState([activeValue]);
  }, [activeValue, data]);

  const actions = menu ? props.actionsFor(menu.ref) : [];

  return (
    <Stack gap={0} flex={1} mih={0}>
      <PaneHeader title="Agents">
        {props.header}
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
          aria-label="Agents"
          renderNode={({ node, expanded, hasChildren, elementProps }) => {
            const ref = parseNodeValue(node.value);
            const row = info.get(node.value);
            const folder = FOLDERS.has(ref.kind);
            const openable = OPENABLE.has(ref.kind);
            const inherited = row?.inherited === true;
            const deleted = row?.deleted ?? false;
            const builtin = ref.kind === "agent" && row?.agent?.builtin;
            const waiting = ref.kind === "loading";
            const agentRow = ref.kind === "agent" ? row?.agent : undefined;
            const isDefault =
              agentRow !== undefined && agentRow.id === props.defaultId;

            return (
              <TreeRow
                elementProps={elementProps}
                onMouseEnter={() => setNear(node.value)}
                onMouseLeave={() => setNear(null)}
                deleted={deleted}
                waiting={waiting}
                onClick={(e) => {
                  elementProps.onClick(e);

                  if (openable) props.onOpen(ref, false);
                }}
                onDoubleClick={() => {
                  if (openable) props.onOpen(ref, true);
                }}
                onContextMenu={(e) => {
                  if (props.actionsFor(ref).length === 0) return;

                  e.preventDefault();
                  e.stopPropagation();
                  tree.setSelectedState([node.value]);
                  setMenu({ x: e.clientX, y: e.clientY, ref });
                }}
              >
                <TreeChevron
                  show={hasChildren && !waiting}
                  expanded={expanded}
                />
                <TreeIcon inherited={inherited}>
                  {waiting ? null : ref.kind === "agent" ? (
                    builtin ? (
                      <IconLock size={16} aria-label="Built-in agent" />
                    ) : (
                      <IconRobot size={16} />
                    )
                  ) : inherited &&
                    (ref.kind === "skill" || ref.kind === "schema") ? (
                    <IconLink size={16} aria-label="Inherited" />
                  ) : ref.kind === "skills" ? (
                    <IconBolt size={16} />
                  ) : ref.kind === "schemas" ? (
                    <IconSchema size={16} />
                  ) : ref.kind === "schema" ? (
                    <IconSchema size={16} />
                  ) : ref.kind === "data" ? (
                    <IconFileDatabase size={16} />
                  ) : ref.kind === "file" ? (
                    <IconFile size={16} />
                  ) : folder ? (
                    expanded && hasChildren ? (
                      <IconFolderOpen size={16} />
                    ) : (
                      <IconFolder size={16} />
                    )
                  ) : null}
                </TreeIcon>
                <Text
                  size="sm"
                  truncate
                  fw={ref.kind === "root" ? 600 : undefined}
                  td={deleted ? "line-through" : undefined}
                  flex={1}
                  miw={0}
                  {...(inherited
                    ? { c: INHERITED }
                    : waiting
                      ? { c: "dimmed" }
                      : {})}
                >
                  {node.label}
                </Text>
                {row?.clash && (
                  <Tooltip label={row.clash} openDelay={300}>
                    <Badge color="orange" tt="none">
                      {row.clash}
                    </Badge>
                  </Tooltip>
                )}
                {ref.kind === "agent" && (
                  <Group gap={4} wrap="nowrap">
                    {(row?.agent?.newTools ?? 0) > 0 && (
                      <Badge color="blue">{row?.agent?.newTools} new</Badge>
                    )}
                  </Group>
                )}
                {agentRow && !agentRow.deleted && (
                  <Tooltip
                    label={
                      props.defaultLocked ??
                      (isDefault
                        ? "The default agent. Click to clear it."
                        : "Make this the default agent")
                    }
                    openDelay={400}
                  >
                    <ActionIcon
                      variant="transparent"
                      color={isDefault ? "teal" : "gray"}
                      role="radio"
                      aria-checked={isDefault}
                      aria-label={`Default agent: ${agentRow.name}`}
                      disabled={props.defaultLocked !== undefined}
                      opacity={isDefault || near === node.value ? 1 : 0}
                      onFocus={() => setNear(node.value)}
                      onBlur={() => setNear(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSetDefault(isDefault ? null : agentRow.id);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {isDefault ? (
                        <IconCircleCheck size={16} />
                      ) : (
                        <IconCircle size={16} />
                      )}
                    </ActionIcon>
                  </Tooltip>
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
          {menu && OPENABLE.has(menu.ref.kind) && (
            <Menu.Item onClick={() => props.onOpen(menu.ref, true)}>
              Open
            </Menu.Item>
          )}
          {actions.map((a) => (
            <Menu.Item
              key={a.label}
              {...(a.color ? { color: a.color } : {})}
              onClick={a.onClick}
            >
              {a.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}

function ancestors(nodes: readonly TreeNode[], value: string): string[] {
  const walk = (list: readonly TreeNode[], path: string[]): string[] | null => {
    for (const n of list) {
      if (n.value === value) return path;

      const found = n.children ? walk(n.children, [...path, n.value]) : null;

      if (found) return found;
    }

    return null;
  };

  return walk(nodes, []) ?? [];
}
