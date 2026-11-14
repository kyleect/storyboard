import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Menu,
  ScrollArea,
  Text,
  Tooltip,
  Tree,
  useTree,
} from "@mantine/core";
import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
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

const INHERITED = "var(--mantine-color-blue-6)";

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
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
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
          Agents
        </Text>
        <Box style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {props.header}
          <Tooltip
            label={showDeleted ? "Hide deleted items" : "Show deleted items"}
            openDelay={400}
          >
            <ActionIcon
              variant={showDeleted ? "light" : "subtle"}
              color="gray"
              size="sm"
              aria-label="Show deleted"
              aria-pressed={showDeleted}
              onClick={props.onToggleDeleted}
            >
              {showDeleted ? <IconEye size={16} /> : <IconEyeOff size={16} />}
            </ActionIcon>
          </Tooltip>
        </Box>
      </Box>

      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
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
              <div
                {...elementProps}
                onMouseEnter={() => setNear(node.value)}
                onMouseLeave={() => setNear(null)}
                style={{
                  ...elementProps.style,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingBlock: 3,
                  paddingInlineEnd: 8,
                  cursor: waiting ? "default" : "pointer",
                  userSelect: "none",
                  opacity: deleted ? 0.6 : 1,
                }}
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
                <span
                  style={{
                    width: 14,
                    display: "inline-flex",
                    flexShrink: 0,
                    color: "var(--mantine-color-dimmed)",
                  }}
                >
                  {hasChildren && !waiting ? (
                    expanded ? (
                      <IconChevronDown size={14} />
                    ) : (
                      <IconChevronRight size={14} />
                    )
                  ) : null}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    flexShrink: 0,
                    ...(inherited ? { color: INHERITED } : {}),
                  }}
                >
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
                </span>
                <Text
                  size="sm"
                  truncate
                  fw={ref.kind === "root" ? 600 : undefined}
                  td={deleted ? "line-through" : undefined}
                  {...(waiting ? { c: "dimmed" } : {})}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    ...(inherited ? { color: INHERITED } : {}),
                  }}
                >
                  {node.label}
                </Text>
                {row?.clash && (
                  <Tooltip label={row.clash} openDelay={300}>
                    <Badge size="xs" variant="light" color="orange" tt="none">
                      {row.clash}
                    </Badge>
                  </Tooltip>
                )}
                {ref.kind === "agent" && (
                  <Group gap={4} wrap="nowrap">
                    {(row?.agent?.newTools ?? 0) > 0 && (
                      <Badge size="xs" variant="light" color="blue">
                        {row?.agent?.newTools} new
                      </Badge>
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
                      size="sm"
                      color={isDefault ? "teal" : "gray"}
                      role="radio"
                      aria-checked={isDefault}
                      aria-label={`Default agent: ${agentRow.name}`}
                      disabled={props.defaultLocked !== undefined}
                      style={{
                        opacity: isDefault || near === node.value ? 1 : 0,
                      }}
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
    </Box>
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
