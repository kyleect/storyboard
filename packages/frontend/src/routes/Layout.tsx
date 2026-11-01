import {
  Anchor,
  AppShell,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../api";
import { useAppEvents } from "../live";
import { usePicked } from "../picked";
import { UsageBadge } from "./ContextMeter";
import { SessionMenu, showError, useProjectActions } from "./SessionActions";

const NO_PROJECT = "none";
const NEW_PROJECT = "new";

export function Layout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const projectActions = useProjectActions();
  const picked = usePicked((s) => s.projectId);
  const pick = usePicked((s) => s.pick);
  // Agent changes from any window (agents plan, P7).
  useAppEvents();

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const sessions = useQuery({
    queryKey: ["sessions", picked],
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
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      // Creating a session in a project counts as using it.
      if (picked !== null)
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: session.id },
      });
    },
    onError: showError("Could not create a session"),
  });

  return (
    <AppShell navbar={{ width: 260, breakpoint: "sm" }} padding="md">
      <AppShell.Navbar p="sm">
        <Stack gap="sm" h="100%">
          <Group justify="space-between">
            <Title order={4}>Harness</Title>
            <Button
              size="xs"
              onClick={() => create.mutate()}
              loading={create.isPending}
            >
              New session
            </Button>
          </Group>
          <Stack gap={4}>
            <Select
              aria-label="Project"
              size="xs"
              allowDeselect={false}
              data={[
                { value: NO_PROJECT, label: "No project" },
                ...(projects.data ?? []).map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
                { value: NEW_PROJECT, label: "New project…" },
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
            {projects.isError && (
              <Text c="red" size="xs">
                {projects.error.message}
              </Text>
            )}
          </Stack>
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
            {sessions.data?.map((s) => (
              <NavLink
                key={s.id}
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/sessions/$sessionId"
                    params={{ sessionId: s.id }}
                  />
                )}
                label={s.title}
                description={new Date(s.created_at).toLocaleString()}
                active={params.sessionId === s.id}
                rightSection={
                  <Group gap={4} wrap="nowrap">
                    <UsageBadge usage={s.usage} />
                    <SessionMenu session={s} />
                  </Group>
                }
              />
            ))}
          </ScrollArea>
          <NavLink
            renderRoot={(props) => <Link {...props} to="/files" />}
            label="Files & memory"
          />
          <NavLink
            renderRoot={(props) => <Link {...props} to="/agents" />}
            label="Agents"
          />
          <NavLink
            renderRoot={(props) => <Link {...props} to="/settings" />}
            label="Settings"
          />
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
