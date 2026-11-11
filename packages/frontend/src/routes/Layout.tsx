import {
  Anchor,
  AppShell,
  Button,
  Collapse,
  Group,
  NavLink,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../api";
import { projectKeys, sessionKeys } from "../queries";
import { useAppEvents } from "../live";
import { usePicked } from "../picked";
import { useActiveRuns } from "../runs";
import { GlobalRunIndicator, SessionRunBadge } from "./RunIndicator";
import { SessionMenu, showError, useProjectActions } from "./SessionActions";
import { useDisclosure } from "@mantine/hooks";

const NO_PROJECT = "none";
const NEW_PROJECT = "new";

export function Layout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  // The session list is shown on the Sessions page and on a session page
  // (Sessions page plan, D2). The project picker, and the project links that
  // go with it, are also shown on a project's pages; everywhere else the
  // links are stacked together at the top.
  const onSessions =
    pathname === "/sessions" || pathname.startsWith("/sessions/");
  const showSessionList = onSessions;
  const showPicker = onSessions || pathname.startsWith("/projects/");
  const projectActions = useProjectActions();
  const picked = usePicked((s) => s.projectId);
  const pick = usePicked((s) => s.pick);
  const [projectLinksExpanded, { toggle: toggleProjectLinks }] =
    useDisclosure(false);
  // Agent changes from any window (agents plan, P7).
  useAppEvents();
  // Runs in progress in any session, for the activity indicators.
  const activity = useActiveRuns();

  const projects = useQuery({
    queryKey: projectKeys.list(),
    queryFn: api.listProjects,
  });
  const sessions = useQuery({
    queryKey: sessionKeys.list(picked),
    queryFn: () => api.listSessions(picked),
  });

  // A remembered project that is gone (trashed or deleted): No project.
  useEffect(() => {
    if (
      picked !== null &&
      projects.data &&
      !projects.data.some((p) => p.id === picked)
    ) {
      pick(null);
    }
  }, [picked, projects.data, pick]);

  const create = useMutation({
    mutationFn: () => api.createSession(picked),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      // Creating a session in a project counts as using it.
      if (picked !== null)
        await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: session.id },
      });
    },
    onError: showError("Could not create a session"),
  });

  const sessionsLink = (
    <NavLink
      px="md"
      py="xs"
      fw="bold"
      renderRoot={(props) => <Link {...props} to="/sessions" />}
      label="Sessions"
    />
  );

  return (
    <AppShell navbar={{ width: 260, breakpoint: "sm" }} padding="md">
      <AppShell.Navbar p="xs">
        <Stack gap="xs" h="100%">
          <Group justify="space-between">
            <Title order={3}>🤖</Title>
            <GlobalRunIndicator summary={activity.data} />
          </Group>
          {/* Above the picker; where there is no picker it joins the links below. */}
          {showPicker && sessionsLink}
          {showPicker && (
            <Stack gap={4}>
              <Button
                size="xs"
                radius="xs"
                variant="filled"
                onClick={() => create.mutate()}
                loading={create.isPending}
              >
                New Chat
              </Button>
              <Select
                size="sm"
                radius="xs"
                variant={picked ? "filled" : "default"}
                aria-label="Project"
                allowDeselect={false}
                data={[
                  { value: NO_PROJECT, label: "No project selected" },
                  { value: NEW_PROJECT, label: "New project…" },
                  ...(projects.data ?? []).map((p) => ({
                    value: p.id,
                    label: `🗂️  ${p.name}`,
                  })),
                ]}
                value={picked ?? NO_PROJECT}
                onChange={(value) => {
                  if (value === NEW_PROJECT) {
                    projectActions.openCreate((project) => pick(project.id));
                  } else {
                    pick(value === NO_PROJECT || value === null ? null : value);
                  }
                }}
              />

              {projects.isError && (
                <Text c="red" size="xs">
                  {projects.error.message}
                </Text>
              )}
            </Stack>
          )}

          {showSessionList && (
            <ScrollArea style={{ flex: 1 }}>
              {sessions.isError && (
                <Text c="red" size="sm">
                  {sessions.error.message}
                </Text>
              )}
              {sessions.data?.length === 0 && (
                <Text c="dimmed" size="sm">
                  No sessions.
                </Text>
              )}
              <Stack gap={0}>
                {sessions.data?.map((s) => (
                  <NavLink
                    p={5}
                    variant="subtle"
                    key={s.id}
                    renderRoot={(props) => (
                      <Link
                        {...props}
                        to="/sessions/$sessionId"
                        params={{ sessionId: s.id }}
                      />
                    )}
                    label={s.title}
                    active={params.sessionId === s.id}
                    rightSection={
                      <Group gap={4} wrap="nowrap">
                        <SessionRunBadge
                          state={activity.data?.bySession[s.id]}
                        />
                        <SessionMenu session={s} />
                      </Group>
                    }
                    styles={{
                      body: { minWidth: 0 },
                      label: {
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    }}
                  />
                ))}
              </Stack>
            </ScrollArea>
          )}

          {showPicker && picked && (
            <Stack>
              <Collapse
                expanded={projectLinksExpanded}
                onClick={toggleProjectLinks}
              >
                <Stack gap="xs">
                  {picked !== null && (
                    <Anchor
                      size="xs"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/projects/$projectId"
                          params={{ projectId: picked }}
                        />
                      )}
                    >
                      Open project page
                    </Anchor>
                  )}
                  {picked !== null && (
                    <Anchor
                      size="xs"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/projects/$projectId/files"
                          params={{ projectId: picked }}
                        />
                      )}
                    >
                      Project files & memory
                    </Anchor>
                  )}
                  {picked !== null && (
                    <Anchor
                      size="xs"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/projects/$projectId/agents"
                          params={{ projectId: picked }}
                        />
                      )}
                    >
                      Project agents
                    </Anchor>
                  )}
                  {picked !== null && (
                    <Anchor
                      size="xs"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/projects/$projectId/skills"
                          params={{ projectId: picked }}
                        />
                      )}
                    >
                      Project skills
                    </Anchor>
                  )}
                  {picked !== null && (
                    <Anchor
                      size="xs"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/projects/$projectId/data"
                          params={{ projectId: picked }}
                        />
                      )}
                    >
                      Project schemas & data
                    </Anchor>
                  )}
                </Stack>
              </Collapse>

              <Button
                onClick={toggleProjectLinks}
                size="compact-xs"
                variant="outline"
                radius="sm"
              >
                {projectLinksExpanded ? "Close" : "Project Links"}
              </Button>
            </Stack>
          )}

          <Stack gap={0}>
            {!showPicker && sessionsLink}
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/agents" />}
              label="Agents"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/skills" />}
              label="Skills"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/files" />}
              label="Files/Memory"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/data" />}
              label="Structural Data"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/workspaces" />}
              label="Workspaces"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/errors" />}
              label="Errors"
            />
            <NavLink
              px="md"
              py="xs"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/settings" />}
              label="Settings"
            />
          </Stack>
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

export function Home() {
  return <Text c="dimmed">Create a session or pick one on the left.</Text>;
}
