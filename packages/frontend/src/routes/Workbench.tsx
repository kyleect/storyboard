import { Box, Drawer, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  IconAlertTriangle,
  IconBolt,
  IconBox,
  IconDatabase,
  IconFiles,
  IconFolder,
  IconList,
  IconMenu2,
  IconMessage,
  IconRobot,
  IconSettings,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { TabIdContext, useDirtyTabs } from "../dirty";
import { dropDraft } from "../drafts";
import { useChatStatus } from "../chatStatus";
import { tabId } from "../explorer";
import { projectKeys, sessionKeys } from "../queries";
import { useActiveRuns } from "../runs";
import {
  newChatTarget,
  pathForTab,
  projectOfTab,
  tabForPath,
  type NewWorkbenchTab,
  type WorkbenchKind,
  type WorkbenchTab,
} from "../workbench";
import { setWorkbenchNavigator, useWorkbench } from "../workbenchStore";
import { GlobalAgentsPage, ProjectAgentsPage } from "./Agents";
import { Chat } from "./Chat";
import { ChatsTree, type FocusedRow } from "./ChatsTree";
import { GlobalEntriesPage, ProjectEntriesPage } from "./EntriesPages";
import { ErrorsPage } from "./Errors";
import { ExplorerShell, type ShellTab } from "./ExplorerShell";
import { ProjectPage } from "./ProjectPage";
import { Rail } from "./Rail";
import { showError, useProjectActions } from "./SessionActions";
import { SessionsPage } from "./Sessions";
import { Settings } from "./Settings";
import { GlobalSkillsPage, ProjectSkillsPage } from "./Skills";
import {
  GlobalStructuredDataPage,
  ProjectStructuredDataPage,
} from "./StructuredDataPages";
import { WorkspacesPage } from "./Workspaces";

/*
 * The chat workbench (chat workbench design): the icon rail, the chats tree,
 * and the tabs, in the frame the Files and Structured Data views use.
 *
 * The address decides which tab is active. A tab that is clicked navigates;
 * an address that is opened (a link, the address bar, Back) opens or
 * activates its tab. Only the active tab is mounted, and tabs with unsaved
 * edits, which stay mounted, hidden (D5).
 */

const ICONS: Record<WorkbenchKind, ReactNode> = {
  chat: <IconMessage size={14} />,
  sessions: <IconList size={14} />,
  project: <IconFolder size={14} />,
  "project-files": <IconFiles size={14} />,
  "project-agents": <IconRobot size={14} />,
  "project-skills": <IconBolt size={14} />,
  "project-data": <IconDatabase size={14} />,
  agents: <IconRobot size={14} />,
  skills: <IconBolt size={14} />,
  files: <IconFiles size={14} />,
  data: <IconDatabase size={14} />,
  workspaces: <IconBox size={14} />,
  errors: <IconAlertTriangle size={14} />,
  settings: <IconSettings size={14} />,
};

const GLOBAL_LABEL: Partial<Record<WorkbenchKind, string>> = {
  sessions: "All chats",
  agents: "Agents",
  skills: "Skills",
  files: "Files & memory",
  data: "Structured data",
  workspaces: "Workspaces",
  errors: "Errors",
  settings: "Settings",
};

const PROJECT_SUFFIX: Partial<Record<WorkbenchKind, string>> = {
  sessions: "chats",
  "project-files": "files",
  "project-agents": "agents",
  "project-skills": "skills",
  "project-data": "data",
};

/** The page a tab shows. */
function TabPage({ tab }: { tab: WorkbenchTab }) {
  const id = tab.key;
  switch (tab.kind) {
    case "chat":
      return <Chat sessionId={id} />;
    case "sessions":
      return <SessionsPage projectId={tab.root === "project" ? id : null} />;
    case "project":
      return <ProjectPage projectId={id} />;
    case "project-files":
      return <ProjectEntriesPage projectId={id} />;
    case "project-agents":
      return <ProjectAgentsPage projectId={id} />;
    case "project-skills":
      return <ProjectSkillsPage projectId={id} />;
    case "project-data":
      return <ProjectStructuredDataPage projectId={id} />;
    case "agents":
      return <GlobalAgentsPage />;
    case "skills":
      return <GlobalSkillsPage />;
    case "files":
      return <GlobalEntriesPage />;
    case "data":
      return <GlobalStructuredDataPage />;
    case "workspaces":
      return <WorkspacesPage />;
    case "errors":
      return <ErrorsPage />;
    case "settings":
      return <Settings />;
  }
}

export function Workbench() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useLocation({ select: (l) => l.pathname });
  const small = useMediaQuery("(max-width: 48em)") ?? false;
  const [drawer, drawerHandlers] = useDisclosure(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const activity = useActiveRuns();
  const projectActions = useProjectActions();
  const chatStatus = useChatStatus((s) => s.status);

  const tabs = useWorkbench((s) => s.tabs);
  const width = useWorkbench((s) => s.width);
  const settingsPath = useWorkbench((s) => s.settingsPath);
  const dirty = useDirtyTabs((s) => s.dirty);
  // The tree row that was used last, for New chat.
  const [focused, setFocused] = useState<FocusedRow | null>(null);

  const go = (path: string, replace = false) =>
    void navigate({ to: path, replace, hash: "" } as never);
  useEffect(() => {
    setWorkbenchNavigator((path) => go(path));
    return () => setWorkbenchNavigator(null);
    // go() only calls navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  // Back to the tab that was active when the page was last open.
  useEffect(() => {
    if (pathname !== "/") return;
    const { tabs: saved, active } = useWorkbench.getState();
    const tab = saved.find((t) => tabId(t) === active);
    if (tab) go(pathForTab(tab, useWorkbench.getState().settingsPath), true);
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the address decides the active tab
  const current = useMemo(() => tabForPath(pathname), [pathname]);
  const activeId = current ? tabId(current) : null;
  useEffect(() => {
    const store = useWorkbench.getState();
    if (!current) {
      store.setActive(null);
      return;
    }
    const id = tabId(current);
    // A tab that is open is only activated; one that is not, is kept.
    store.open(current, !store.tabs.some((t) => tabId(t) === id));
    if (current.kind === "settings") store.setSettingsPath(pathname);
    // The tab, not the whole address, is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, current?.kind === "settings" ? pathname : null]);

  // The address with the tab's own destination, and the hash of a message.
  const openTab = (tab: NewWorkbenchTab, permanent: boolean) => {
    useWorkbench.getState().open(tab, permanent);
    go(pathForTab(tab, useWorkbench.getState().settingsPath));
  };

  // ---- labels and the project of each tab
  const projects = useQuery({
    queryKey: projectKeys.list(),
    queryFn: api.listProjects,
  });
  const chatTabs = tabs.filter((t) => t.kind === "chat");
  const details = useQueries({
    queries: chatTabs.map((t) => ({
      queryKey: sessionKeys.detail(t.key),
      queryFn: () => api.getSession(t.key),
      staleTime: 30_000,
    })),
  });
  const titleOf = (sessionId: string) =>
    details[chatTabs.findIndex((t) => t.key === sessionId)]?.data?.session
      .title;
  const projectOfSession = (sessionId: string): string | null =>
    queryClient.getQueryData<{ session: { project_id: string | null } }>(
      sessionKeys.detail(sessionId),
    )?.session.project_id ?? null;
  const projectName = (id: string) =>
    projects.data?.find((p) => p.id === id)?.name;

  // A chat that is gone (purged) closes its tab.
  const gone = chatTabs
    .filter((_, i) => {
      const err = details[i]?.error;
      return err instanceof ApiError && err.status === 404;
    })
    .map(tabId);
  const goneKey = gone.join(",");
  useEffect(() => {
    if (gone.length === 0) return;
    const to = useWorkbench.getState().close(gone);
    if (to !== null) go(to, true);
    // Only when the set of missing chats changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goneKey]);

  const labelOf = (t: WorkbenchTab): string => {
    if (t.kind === "chat") return titleOf(t.key) ?? "Chat";
    if (t.kind === "settings") return "Settings";
    if (t.kind === "project") return projectName(t.key) ?? "Project";
    if (t.root === "project") {
      return `${projectName(t.key) ?? "Project"} ${PROJECT_SUFFIX[t.kind] ?? ""}`.trim();
    }
    return GLOBAL_LABEL[t.kind] ?? t.kind;
  };

  const shellTabs: ShellTab[] = tabs.map((t) => {
    const id = tabId(t);
    const label = labelOf(t);
    return {
      id,
      label,
      title: label,
      icon: ICONS[t.kind],
      transient: t.transient,
      dirty: dirty[id] === true,
    };
  });

  // ---- closing
  const close = (ids: readonly string[]) => {
    for (const id of ids) {
      const t = useWorkbench.getState().tabs.find((x) => tabId(x) === id);
      if (t?.kind === "chat") dropDraft(t.key);
    }
    const to = useWorkbench.getState().close(ids);
    if (to !== null) go(to);
  };
  const requestClose = (id: string) => {
    if (useDirtyTabs.getState().dirty[id] !== true) {
      close([id]);
      return;
    }
    const t = tabs.find((x) => tabId(x) === id);
    modals.openConfirmModal({
      title: `Close ${t ? labelOf(t) : "this tab"}?`,
      children: <Text size="sm">Your unsaved changes to it will be lost.</Text>,
      labels: { confirm: "Close", cancel: "Keep open" },
      confirmProps: { color: "red" },
      onConfirm: () => close([id]),
    });
  };

  // Asks before the page is reloaded or left while something is unsaved.
  const anyDirty = Object.keys(dirty).length > 0;
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  // ---- New chat
  const create = useMutation({
    mutationFn: (projectId: string | null) => api.createSession(projectId),
    onSuccess: async (session, projectId) => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      // Creating a session in a project counts as using it.
      if (projectId !== null)
        await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      openTab({ kind: "chat", root: "session", key: session.id }, true);
      drawerHandlers.close();
    },
    onError: showError("Could not create a session"),
  });
  const activeTab = tabs.find((t) => tabId(t) === activeId) ?? null;
  const newChat = (projectId?: string) =>
    create.mutate(
      projectId !== undefined
        ? projectId
        : newChatTarget({ focused, active: activeTab, projectOfSession }),
    );

  // ---- what the status bar says
  const activeProject = activeTab
    ? projectOfTab(activeTab, projectOfSession)
    : null;
  const statusLeft = activeTab
    ? `${activeProject ? (projectName(activeProject) ?? "Project") : "No project"} · ${labelOf(activeTab)}`
    : "";
  const status =
    activeTab?.kind === "chat" && chatStatus?.sessionId === activeTab.key
      ? chatStatus
      : null;
  const statusRight = status ? (
    <>
      {status.model && (
        <Text size="xs" c="dimmed">
          {status.model}
        </Text>
      )}
      {status.contextTokens !== undefined && (
        <Text size="xs" c="dimmed">
          {status.contextTokens.toLocaleString()} tokens
        </Text>
      )}
      <Text size="xs" c={status.connected ? "green" : "dimmed"}>
        {status.connected ? "live" : "offline"}
      </Text>
    </>
  ) : null;

  // ---- the tabs that are mounted
  const hosted = tabs.filter(
    (t) => tabId(t) === activeId || dirty[tabId(t)] === true,
  );
  const content =
    activeId === null && hosted.length === 0 ? null : (
      <>
        {hosted.map((t) => {
          const id = tabId(t);
          return (
            <Box
              key={id}
              role="tabpanel"
              aria-label={labelOf(t)}
              hidden={id !== activeId}
              p="md"
              style={{
                height: "100%",
                overflow: t.kind === "chat" ? "hidden" : "auto",
                display: id === activeId ? undefined : "none",
              }}
            >
              <TabIdContext.Provider value={id}>
                <TabPage tab={t} />
              </TabIdContext.Provider>
            </Box>
          );
        })}
      </>
    );

  const tree = (
    <ChatsTree
      activeId={activeId}
      onOpen={(tab, permanent) => {
        openTab(tab, permanent);
        if (!permanent) drawerHandlers.close();
      }}
      onFocusRow={setFocused}
      onNewChat={newChat}
      onNewProject={() =>
        projectActions.openCreate((project) =>
          openTab({ kind: "project", root: "project", key: project.id }, true),
        )
      }
      creating={create.isPending}
      activity={activity.data}
      searchRef={searchRef}
    />
  );
  const rail = (
    <Rail
      activeKind={activeTab?.kind ?? null}
      activity={activity.data}
      onChats={() => {
        if (small) drawerHandlers.open();
        else searchRef.current?.focus();
      }}
      onOpen={(kind) => {
        setFocused(null);
        openTab({ kind, root: "global", key: "" }, true);
        drawerHandlers.close();
      }}
    />
  );

  return (
    <Box
      style={{
        display: "flex",
        height: "100vh",
        minHeight: 0,
      }}
    >
      {!small && rail}
      <Box style={{ flex: 1, minWidth: 0, padding: small ? 0 : 8 }}>
        <ExplorerShell
          width={width}
          onWidthChange={useWorkbench.getState().setWidth}
          sidebar={tree}
          tabs={shellTabs}
          active={activeId}
          onActivate={(id) => {
            const t = tabs.find((x) => tabId(x) === id);
            setFocused(null);
            if (t) go(pathForTab(t, settingsPath));
          }}
          onKeep={(id) => useWorkbench.getState().keep(id)}
          onRequestClose={requestClose}
          content={content}
          empty="Open a chat or a project from the list."
          statusLeft={statusLeft}
          statusRight={statusRight}
          tabListLabel="Open pages"
          resizeLabel="Resize the chats list"
          hideSidebar={small}
          hideStatus={small}
          leading={
            small ? (
              <UnstyledButton
                aria-label="Open the menu"
                onClick={drawerHandlers.open}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0 10px",
                  flexShrink: 0,
                }}
              >
                <IconMenu2 size={18} />
              </UnstyledButton>
            ) : null
          }
        />
      </Box>
      {small && (
        <Drawer
          opened={drawer}
          onClose={drawerHandlers.close}
          size="85%"
          padding={0}
          withCloseButton={false}
          aria-label="Menu"
        >
          <Box style={{ display: "flex", height: "100vh" }}>
            {rail}
            <Box style={{ flex: 1, minWidth: 0 }}>{tree}</Box>
          </Box>
        </Drawer>
      )}
    </Box>
  );
}
