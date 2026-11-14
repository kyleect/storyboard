import {
  ActionIcon,
  Box,
  Group,
  Menu,
  ScrollArea,
  Text,
  TextInput,
  Tooltip,
  Stack,
} from "@mantine/core";
import utils from "../../../styles/utilities.module.css";
import { useProjects } from "../../../hooks/useProjects";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFolder,
  IconFolderPlus,
  IconInbox,
  IconMessage,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ProjectColor } from "@harness/core";
import { api, type Project, type SessionListItem } from "../../../api";
import { projectColorVar } from "../../../lib/project-color";
import { sessionKeys } from "../../../queries";
import type { RunSummary } from "../../../hooks/useActiveRuns";
import { useWorkbench } from "../../../stores/workbench";
import { tabId as idOf } from "../../../lib/explorer";
import type { NewWorkbenchTab } from "../../../lib/workbench";
import { SessionRunBadge } from "./RunIndicator";
import {
  useUnreadSessions,
  type UnreadSessions,
} from "../../../hooks/useUnreadSessions";
import { UnreadDot } from "../../../components/UnreadDot";
import { SessionMenu } from "../../../components/SessionMenu";
import { useProjectActions } from "../../../hooks/useProjectActions";

export const NO_PROJECT_NODE = "none";
const projectNode = (id: string) => `project:${id}`;

export const TREE_CHATS = 5;

export interface FocusedRow {
  projectId: string | null;
}

interface Handlers {
  activeId: string | null;
  onOpen: (tab: NewWorkbenchTab, permanent: boolean) => void;
  onFocusRow: (row: FocusedRow) => void;
  activity: RunSummary | undefined;
  filter: string;
  unread: UnreadSessions;
}

const selectedChatBackground = (color: ProjectColor) =>
  `light-dark(var(--mantine-color-${color}-light-hover), color-mix(in srgb, var(--mantine-color-${color}-filled) 18%, transparent))`;

function Row({
  label,
  icon,
  depth,
  active,
  onClick,
  onDoubleClick,
  right,
  expanded,
  onToggle,
  bold,
  tint,
  selectedTint,
}: {
  label: string;
  icon: ReactNode;
  depth: number;
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  right?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  bold?: boolean;
  tint?: ProjectColor | null;
  selectedTint?: ProjectColor | null | undefined;
}) {
  return (
    <Group
      role="treeitem"
      aria-selected={active}
      aria-expanded={expanded}
      aria-level={depth + 1}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      gap={6}
      wrap="nowrap"
      fz={13}
      fw={bold ? 600 : undefined}
      bg={
        tint
          ? `var(--mantine-color-${tint}-${active ? "light-hover" : "light"})`
          : active
            ? selectedTint
              ? selectedChatBackground(selectedTint)
              : "var(--mantine-primary-color-light)"
            : "transparent"
      }
      bdrs={4}
      className={utils.pointer}
      py={3}
      pr={6}
      pl={6 + depth * 14}
      style={{
        boxShadow:
          tint && active
            ? `inset 3px 0 0 var(--mantine-color-${tint}-filled)`
            : undefined,
      }}
    >
      {expanded === undefined ? null : (
        <Box
          component="span"
          display="inline-flex"
          role="button"
          aria-label={expanded ? `Close ${label}` : `Open ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
        >
          {expanded ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )}
        </Box>
      )}
      {icon}
      <Text span size="sm" fw="inherit" flex={1} miw={0} truncate>
        {label}
      </Text>
      {right}
    </Group>
  );
}

const matches = (text: string, filter: string) =>
  filter === "" || text.toLowerCase().includes(filter);

const groupHasUnread = (h: Handlers, projectId: string | null) =>
  h.unread.sessions.some(
    (s) =>
      s.projectId === projectId && h.activity?.bySession[s.id] === undefined,
  );

function ChatRow({
  session,
  depth,
  h,
  color,
}: {
  session: SessionListItem;
  depth: number;
  h: Handlers;
  color?: ProjectColor | null | undefined;
}) {
  const tab: NewWorkbenchTab = {
    kind: "chat",
    root: "session",
    key: session.id,
  };
  return (
    <Row
      label={session.title}
      icon={<IconMessage size={14} color={projectColorVar(color)} />}
      depth={depth}
      active={h.activeId === idOf(tab)}
      selectedTint={color}
      onClick={() => {
        h.onFocusRow({ projectId: session.project_id });
        h.onOpen(tab, false);
      }}
      onDoubleClick={() => h.onOpen(tab, true)}
      right={
        <Group gap={4} wrap="nowrap">
          <SessionRunBadge
            state={h.activity?.bySession[session.id]}
            unread={session.unread}
          />
          <SessionMenu session={session} />
        </Group>
      }
    />
  );
}

function ChatList({
  projectId,
  sessions,
  depth,
  h,
  color,
}: {
  projectId: string | null;
  sessions: readonly SessionListItem[];
  depth: number;
  h: Handlers;
  color?: ProjectColor | null | undefined;
}) {
  const filtering = h.filter !== "";
  const shown = filtering
    ? sessions.filter((s) => matches(s.title, h.filter))
    : sessions.slice(0, TREE_CHATS);
  const all: NewWorkbenchTab =
    projectId === null
      ? { kind: "sessions", root: "global", key: "" }
      : { kind: "project", root: "project", key: projectId };
  return (
    <>
      {shown.map((s) => (
        <ChatRow key={s.id} session={s} depth={depth} h={h} color={color} />
      ))}
      {!filtering && sessions.length > TREE_CHATS && (
        <Row
          label={`Show all ${sessions.length} chats`}
          icon={null}
          depth={depth}
          active={false}
          onClick={() => {
            h.onFocusRow({ projectId });
            h.onOpen(all, false);
          }}
          onDoubleClick={() => h.onOpen(all, true)}
        />
      )}
    </>
  );
}

function ProjectMenu({
  project,
  onNewChat,
  onOpenPage,
}: {
  project: Project;
  onNewChat: (projectId: string) => void;
  onOpenPage: (kind: NewWorkbenchTab["kind"]) => void;
}) {
  const actions = useProjectActions();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          color="gray"
          variant="subtle"
          size="sm"
          aria-label={`Actions for ${project.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <IconDots size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
        <Menu.Item onClick={() => onNewChat(project.id)}>New chat</Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={() => onOpenPage("project-files")}>Files</Menu.Item>
        <Menu.Item onClick={() => onOpenPage("agents")}>Agents</Menu.Item>
        <Menu.Item onClick={() => onOpenPage("skills")}>Skills</Menu.Item>
        <Menu.Item onClick={() => onOpenPage("project-data")}>
          Structured Data
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" onClick={() => actions.confirmTrash(project)}>
          Move to trash
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function ProjectGroup({
  project,
  h,
  onNewChat,
}: {
  project: Project;
  h: Handlers;
  onNewChat: (projectId: string) => void;
}) {
  const node = projectNode(project.id);
  const open = useWorkbench((s) => s.expanded[node] ?? false);
  const setExpanded = useWorkbench((s) => s.setExpanded);
  const sessions = useQuery({
    queryKey: sessionKeys.list(project.id),
    queryFn: () => api.listSessions(project.id),
    enabled: open,
  });
  const loaded = sessions.data ?? [];
  const visible =
    matches(project.name, h.filter) ||
    loaded.some((s) => matches(s.title, h.filter));
  if (!visible) return null;
  const tab: NewWorkbenchTab = {
    kind: "project",
    root: "project",
    key: project.id,
  };
  return (
    <div role="group" aria-label={project.name}>
      <Row
        label={project.name}
        icon={<IconFolder size={14} />}
        tint={project.color}
        depth={0}
        bold
        expanded={open}
        active={h.activeId === idOf(tab)}
        onClick={() => {
          h.onFocusRow({ projectId: project.id });
          setExpanded(node, true);
          h.onOpen(tab, false);
        }}
        onToggle={() => setExpanded(node, !open)}
        onDoubleClick={() => h.onOpen(tab, true)}
        right={
          <Group gap={4} wrap="nowrap">
            {groupHasUnread(h, project.id) && (
              <UnreadDot label="Has a chat with a new reply" />
            )}
            <ProjectMenu
              project={project}
              onNewChat={onNewChat}
              onOpenPage={(kind) =>
                h.onOpen({ kind, root: "project", key: project.id }, false)
              }
            />
          </Group>
        }
      />
      {open && (
        <>
          {sessions.isError && (
            <Text c="red" size="xs" pl={34}>
              {sessions.error.message}
            </Text>
          )}
          <ChatList
            projectId={project.id}
            sessions={loaded}
            depth={1}
            h={h}
            color={project.color}
          />
        </>
      )}
    </div>
  );
}

function NoProjectGroup({ h }: { h: Handlers }) {
  const open = useWorkbench((s) => s.expanded[NO_PROJECT_NODE] ?? true);
  const setExpanded = useWorkbench((s) => s.setExpanded);
  const sessions = useQuery({
    queryKey: sessionKeys.list(null),
    queryFn: () => api.listSessions(null),
    enabled: open,
  });
  const loaded = sessions.data ?? [];
  const visible =
    matches("No project", h.filter) ||
    loaded.some((s) => matches(s.title, h.filter));
  if (!visible) return null;
  const tab: NewWorkbenchTab = { kind: "sessions", root: "global", key: "" };
  return (
    <div role="group" aria-label="No project">
      <Row
        label="No project"
        icon={<IconInbox size={14} />}
        depth={0}
        bold
        expanded={open}
        active={h.activeId === idOf(tab)}
        onClick={() => {
          h.onFocusRow({ projectId: null });
          setExpanded(NO_PROJECT_NODE, true);
          h.onOpen(tab, false);
        }}
        onDoubleClick={() => h.onOpen(tab, true)}
        onToggle={() => setExpanded(NO_PROJECT_NODE, !open)}
        right={
          groupHasUnread(h, null) ? (
            <UnreadDot label="Has a chat with a new reply" />
          ) : null
        }
      />
      {open && (
        <>
          {sessions.isError && (
            <Text c="red" size="xs" pl={34}>
              {sessions.error.message}
            </Text>
          )}
          {sessions.data?.length === 0 && h.filter === "" && (
            <Text c="dimmed" size="xs" pl={34}>
              No chats.
            </Text>
          )}
          <ChatList projectId={null} sessions={loaded} depth={1} h={h} />
        </>
      )}
    </div>
  );
}

export function ChatsTree({
  activeId,
  onOpen,
  onFocusRow,
  onNewChat,
  onNewProject,
  creating,
  activity,
}: {
  activeId: string | null;
  onOpen: (tab: NewWorkbenchTab, permanent: boolean) => void;
  onFocusRow: (row: FocusedRow) => void;
  onNewChat: (projectId?: string) => void;
  onNewProject: () => void;
  creating: boolean;
  activity: RunSummary | undefined;
}) {
  const [filter, setFilter] = useState("");
  const projects = useProjects();
  const unread = useUnreadSessions();
  const h: Handlers = {
    activeId,
    onOpen,
    onFocusRow,
    activity,
    filter: filter.trim().toLowerCase(),
    unread,
  };
  const sorted = [...(projects.data ?? [])].sort((a, b) =>
    b.last_used_at.localeCompare(a.last_used_at),
  );

  return (
    <Stack gap={0} h="100%">
      <Group justify="space-between" px="xs" py={6} wrap="nowrap">
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          Chats
        </Text>
        <Group gap={2} wrap="nowrap">
          <Tooltip label="New chat">
            <ActionIcon
              aria-label="New chat"
              variant="subtle"
              loading={creating}
              onClick={() => onNewChat()}
            >
              <IconPlus size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="New project">
            <ActionIcon
              aria-label="New project"
              variant="subtle"
              onClick={onNewProject}
            >
              <IconFolderPlus size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Box px="xs" pb={6}>
        <TextInput
          size="xs"
          aria-label="Filter chats"
          placeholder="Filter"
          leftSection={<IconSearch size={14} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
      </Box>
      <ScrollArea flex={1} px={4}>
        <div role="tree" aria-label="Chats">
          {projects.isError && (
            <Text c="red" size="xs" px="xs">
              {projects.error.message}
            </Text>
          )}
          {sorted.map((p) => (
            <ProjectGroup key={p.id} project={p} h={h} onNewChat={onNewChat} />
          ))}
          <NoProjectGroup h={h} />
        </div>
        {h.filter !== "" && (
          <Text size="xs" c="dimmed" px="xs" py={6}>
            Matches project names and the chats shown; open a project to search
            its chats.
          </Text>
        )}
      </ScrollArea>
    </Stack>
  );
}
