import {
  ActionIcon,
  Box,
  Group,
  Menu,
  ScrollArea,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
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
import { api, type Project, type SessionListItem } from "../api";
import { projectKeys, sessionKeys } from "../queries";
import type { RunSummary } from "../runs";
import { useWorkbench } from "../workbenchStore";
import { tabId as idOf } from "../explorer";
import type { NewWorkbenchTab } from "../workbench";
import { SessionRunBadge } from "./RunIndicator";
import { SessionMenu, useProjectActions } from "./SessionActions";
import { useUnreadSessions, type UnreadSessions } from "../unread";
import { UnreadDot } from "./UnreadDot";

/*
 * The chats tree in the workbench's sidebar (chat workbench design, 4.1):
 * each project, newest use first, opening to its latest chats, and "No
 * project" for the standalone chats. A project's row opens its page, which has
 * its other pages and all its chats. A single click opens a tab in italics, a
 * double click keeps it. Chats are read only for the projects that are open.
 */

/** The group of standalone chats; a project's group is `project:<id>`. */
export const NO_PROJECT_NODE = "none";
const projectNode = (id: string) => `project:${id}`;

/** How many chats a project (or "No project") lists before "Show all". */
export const TREE_CHATS = 5;

/** What the tree reports: the row that was used last, for New chat. */
export interface FocusedRow {
  projectId: string | null;
}

interface Handlers {
  activeId: string | null;
  /** One click opens in italics; `permanent` (two clicks) keeps the tab. */
  onOpen: (tab: NewWorkbenchTab, permanent: boolean) => void;
  onFocusRow: (row: FocusedRow) => void;
  activity: RunSummary | undefined;
  /** Lower-case text the names must contain; empty shows everything. */
  filter: string;
  unread: UnreadSessions;
}

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
}: {
  label: string;
  icon: ReactNode;
  depth: number;
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  right?: ReactNode;
  /** Set for a row that opens and closes. */
  expanded?: boolean;
  /** The chevron's click; a click on the row only ever opens it. */
  onToggle?: () => void;
  bold?: boolean;
}) {
  return (
    <Box
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: `3px 6px 3px ${6 + depth * 14}px`,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: bold ? 600 : undefined,
        background: active ? "var(--mantine-primary-color-light)" : undefined,
        borderRadius: 4,
      }}
    >
      {expanded === undefined ? null : (
        <span
          role="button"
          aria-label={expanded ? `Close ${label}` : `Open ${label}`}
          style={{ display: "inline-flex" }}
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
        </span>
      )}
      {icon}
      <Text
        span
        size="sm"
        fw="inherit"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Text>
      {right}
    </Box>
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
}: {
  session: SessionListItem;
  depth: number;
  h: Handlers;
}) {
  const tab: NewWorkbenchTab = {
    kind: "chat",
    root: "session",
    key: session.id,
  };
  return (
    <Row
      label={session.title}
      icon={<IconMessage size={14} />}
      depth={depth}
      active={h.activeId === idOf(tab)}
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

/**
 * The chats of a project, or of "No project": the first few, then a row that
 * opens the full list (the project's page, or the table of chats with no
 * project). A filter looks through every chat that is loaded.
 */
function ChatList({
  projectId,
  sessions,
  depth,
  h,
}: {
  projectId: string | null;
  sessions: readonly SessionListItem[];
  depth: number;
  h: Handlers;
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
        <ChatRow key={s.id} session={s} depth={depth} h={h} />
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
  /** Opens one of the project's pages. */
  onOpenPage: (kind: NewWorkbenchTab["kind"]) => void;
}) {
  const actions = useProjectActions();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Actions for ${project.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <IconDots size={14} />
        </ActionIcon>
      </Menu.Target>
      {/* The menu is drawn elsewhere, but its clicks still reach the row. */}
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
        <Menu.Item onClick={() => onNewChat(project.id)}>New chat</Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={() => onOpenPage("project-files")}>
          Files & memory
        </Menu.Item>
        <Menu.Item onClick={() => onOpenPage("project-agents")}>
          Agents
        </Menu.Item>
        <Menu.Item onClick={() => onOpenPage("project-skills")}>
          Skills
        </Menu.Item>
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
  // A filter matches the project's name and the chats already loaded.
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
          <ChatList projectId={project.id} sessions={loaded} depth={1} h={h} />
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
  // The table of the chats that have no project, as a project's page has.
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
  /** New chat: from the toolbar (no project given) or a project's menu. */
  onNewChat: (projectId?: string) => void;
  onNewProject: () => void;
  creating: boolean;
  activity: RunSummary | undefined;
}) {
  const [filter, setFilter] = useState("");
  const projects = useQuery({
    queryKey: projectKeys.list(),
    queryFn: api.listProjects,
  });
  const unread = useUnreadSessions();
  const h: Handlers = {
    activeId,
    onOpen,
    onFocusRow,
    activity,
    filter: filter.trim().toLowerCase(),
    unread,
  };
  // The most recently used first; a project never used sorts by creation.
  const sorted = [...(projects.data ?? [])].sort((a, b) =>
    b.last_used_at.localeCompare(a.last_used_at),
  );

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Group justify="space-between" px="xs" py={6} wrap="nowrap">
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          Chats
        </Text>
        <Group gap={2} wrap="nowrap">
          <Tooltip label="New chat">
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="New chat"
              loading={creating}
              onClick={() => onNewChat()}
            >
              <IconPlus size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="New project">
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="New project"
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
      <ScrollArea style={{ flex: 1 }} px={4}>
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
    </Box>
  );
}
