import { Box, Drawer, Text, UnstyledButton, Flex } from "@mantine/core";
import classes from "./Workbench.module.css";
import { confirmAction } from "../../../lib/confirm";
import { useCreateSession } from "../../../hooks/useSessions";
import { useProjects } from "../../../hooks/useProjects";
import {
  useDisclosure,
  useDocumentVisibility,
  useMediaQuery,
} from "@mantine/hooks";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { IconMenu2 } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../../api";
import { TabIdContext, useDirtyTabs } from "../../../stores/dirty";
import { dropDraft } from "../../../stores/drafts";
import { useChatStatus } from "../../../stores/chatStatus";
import { tabId } from "../../../lib/explorer";
import { sessionKeys } from "../../../queries";
import { useActiveRuns } from "../../../hooks/useActiveRuns";
import { useUnreadSessions } from "../../../hooks/useUnreadSessions";
import {
  newChatTarget,
  pathForTab,
  projectOfTab,
  tabForPath,
  type NewWorkbenchTab,
  type WorkbenchKind,
  type WorkbenchTab,
} from "../../../lib/workbench";
import { setWorkbenchNavigator, useWorkbench } from "../../../stores/workbench";
import { ChatsTree, type FocusedRow } from "./ChatsTree";
import { ContextMeter } from "../../../components/ContextMeter";
import {
  ExplorerShell,
  type ShellTab,
} from "../../../components/explorer/ExplorerShell";
import { Rail } from "./Rail";
import { useProjectActions } from "../../../hooks/useProjectActions";
import { ICONS, PAGE_LABEL, TabPage } from "./TabPage";

const FILLS_PANEL: ReadonlySet<WorkbenchKind> = new Set([
  "agents",
  "skills",
  "files",
  "data",
  "project-files",
  "project-data",
]);

export function Workbench() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useLocation({ select: (l) => l.pathname });
  const small = useMediaQuery("(max-width: 48em)") ?? false;
  const [drawer, drawerHandlers] = useDisclosure(false);
  const activity = useActiveRuns();
  const unread = useQuery({
    queryKey: sessionKeys.unreadCount(),
    queryFn: api.unreadSessionCount,
    select: (data) => data.count,
  });
  const projectActions = useProjectActions();
  const chatStatus = useChatStatus((s) => s.status);
  const unreadSessions = useUnreadSessions();

  const tabs = useWorkbench((s) => s.tabs);
  const width = useWorkbench((s) => s.width);
  const sidebarOpen = useWorkbench((s) => s.sidebarOpen);
  const setSidebarOpen = useWorkbench((s) => s.setSidebarOpen);
  const settingsPath = useWorkbench((s) => s.settingsPath);
  const dirty = useDirtyTabs((s) => s.dirty);
  const [focused, setFocused] = useState<FocusedRow | null>(null);

  const go = (path: string, replace = false) =>
    void navigate({ to: path, replace, hash: "" } as never);

  useEffect(() => {
    setWorkbenchNavigator((path) => go(path));

    return () => setWorkbenchNavigator(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    if (pathname !== "/") return;

    const { tabs: saved, active } = useWorkbench.getState();
    const tab = saved.find((t) => tabId(t) === active);

    if (tab) go(pathForTab(tab, useWorkbench.getState().settingsPath), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = useMemo(() => tabForPath(pathname), [pathname]);
  const activeId = current ? tabId(current) : null;

  useEffect(() => {
    const store = useWorkbench.getState();

    if (!current) {
      store.setActive(null);

      return;
    }

    const id = tabId(current);

    store.open(current, !store.tabs.some((t) => tabId(t) === id));

    if (current.kind === "settings") store.setSettingsPath(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, current?.kind === "settings" ? pathname : null]);

  const openTab = (tab: NewWorkbenchTab, permanent: boolean) => {
    useWorkbench.getState().open(tab, permanent);
    go(pathForTab(tab, useWorkbench.getState().settingsPath));
  };

  const projects = useProjects();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goneKey]);

  const partsOf = (t: WorkbenchTab): { prefix?: string; label: string } => {
    if (t.kind === "chat") return { label: titleOf(t.key) ?? "Chat" };

    if (t.kind === "project") return { label: projectName(t.key) ?? "Project" };

    const page = PAGE_LABEL[t.kind] ?? t.kind;

    if (t.root === "project")
      return { prefix: projectName(t.key) ?? "Project", label: page };

    return { label: page };
  };
  const labelOf = (t: WorkbenchTab): string => {
    const { prefix, label } = partsOf(t);

    return prefix ? `${prefix} › ${label}` : label;
  };
  const describe = (t: WorkbenchTab): string => {
    const text = labelOf(t);

    if (t.kind === "chat") return `Chat: ${text}`;

    if (t.kind === "project") return `Project: ${text}`;

    if (t.kind === "sessions") return "Chats that have no project";

    if (t.root === "project") return `Project page: ${text}`;

    return `${text} (all projects)`;
  };

  const shellTabs: ShellTab[] = tabs.map((t) => {
    const id = tabId(t);
    const { prefix, label } = partsOf(t);
    const projectId = projectOfTab(t, projectOfSession);
    const color = projectId
      ? projects.data?.find((p) => p.id === projectId)?.color
      : null;

    return {
      id,
      label,
      ...(prefix ? { prefix } : {}),
      title: describe(t),
      icon: ICONS[t.kind],
      ...(color ? { iconColor: color } : {}),
      transient: t.transient,
      dirty: dirty[id] === true,
      unread:
        t.kind === "chat" && id !== activeId && unreadSessions.ids.has(t.key),
    };
  });

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

    confirmAction({
      title: `Close ${t ? labelOf(t) : "this tab"}?`,
      message: <>Your unsaved changes to it will be lost.</>,
      confirm: "Close",
      cancel: "Keep open",
      danger: true,
      onConfirm: () => close([id]),
    });
  };

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

  const create = useCreateSession((session) => {
    openTab({ kind: "chat", root: "session", key: session.id }, true);
    drawerHandlers.close();
  });
  const { mutate: markSeen } = useMutation({
    mutationFn: (sessionId: string) => api.markSessionSeen(sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() }),
  });
  const visible = useDocumentVisibility() === "visible";
  const seenId = current?.kind === "chat" ? current.key : null;
  const working =
    seenId !== null && activity.data?.bySession[seenId] !== undefined;

  useEffect(() => {
    if (seenId === null || working || !visible) return;

    markSeen(seenId);
  }, [seenId, working, visible, markSeen]);
  const activeTab = tabs.find((t) => tabId(t) === activeId) ?? null;
  const newChat = (projectId?: string) =>
    create.mutate(
      projectId !== undefined
        ? projectId
        : newChatTarget({ focused, active: activeTab, projectOfSession }),
    );

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
      <ContextMeter
        compact
        usage={status.usage}
        model={status.model}
        subagentUsage={status.subagentUsage}
      />
      <Text size="xs" c={status.connected ? "green" : "dimmed"}>
        {status.connected ? "live" : "offline"}
      </Text>
    </>
  ) : null;

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
              h="100%"
              display={id === activeId ? "block" : "none"}
              {...(FILLS_PANEL.has(t.kind) ? {} : { p: "md" })}
              style={{
                overflow:
                  t.kind === "chat" || FILLS_PANEL.has(t.kind)
                    ? "hidden"
                    : "auto",
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
    />
  );
  const rail = (
    <Rail
      activeKind={activeTab?.kind ?? null}
      activity={activity.data}
      unread={unread.data}
      chatsOpen={small ? drawer : sidebarOpen}
      onChats={() => {
        if (small) drawerHandlers.toggle();
        else setSidebarOpen(!sidebarOpen);
      }}
      onOpen={(kind) => {
        setFocused(null);
        openTab({ kind, root: "global", key: "" }, false);
        drawerHandlers.close();
      }}
      onManageProfiles={() => {
        setFocused(null);
        useWorkbench.getState().setSettingsPath("/settings/general/profiles");
        openTab({ kind: "settings", root: "global", key: "" }, false);
        drawerHandlers.close();
      }}
    />
  );

  return (
    <Flex h="100vh" mih={0}>
      {!small && rail}
      <Box flex={1} miw={0} p={small ? 0 : 8}>
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
          hideSidebar={small || !sidebarOpen}
          onReorder={useWorkbench.getState().move}
          hideStatus={small}
          leading={
            small ? (
              <UnstyledButton
                aria-label="Open the menu"
                onClick={drawerHandlers.open}
                flex="none"
                px={10}
                className={classes.menuButton}
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
          <Flex h="100vh">
            {rail}
            <Box flex={1} miw={0}>
              {tree}
            </Box>
          </Flex>
        </Drawer>
      )}
    </Flex>
  );
}
