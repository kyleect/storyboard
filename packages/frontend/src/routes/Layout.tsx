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
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../api";
import { projectKeys, sessionKeys } from "../queries";
import { useAppEvents } from "../live";
import { usePicked } from "../picked";
import { SessionMenu, showError, useProjectActions } from "./SessionActions";
import { useDisclosure } from "@mantine/hooks";

const NO_PROJECT = "none";
const NEW_PROJECT = "new";

export function Layout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const projectActions = useProjectActions();
  const picked = usePicked((s) => s.projectId);
  const pick = usePicked((s) => s.pick);
  const [projectLinksExpanded, { toggle: toggleProjectLinks }] =
    useDisclosure(false);
  // Agent changes from any window (agents plan, P7).
  useAppEvents();

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

  return (
    <AppShell navbar={{ width: 260, breakpoint: "sm" }} padding="md">
      <AppShell.Navbar p="sm">
        <Stack gap="xs" h="100%">
          <Group justify="space-between">
            <Title order={3}>🤖</Title>
            <Button
              size="compact-xs"
              radius="sm"
              variant="gradient"
              onClick={() => create.mutate()}
              loading={create.isPending}
            >
              New session
            </Button>
          </Group>
          <Stack gap={4}>
            <Select
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
                  variant="filled"
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
                      <SessionMenu session={s} />
                    </Group>
                  }
                />
              ))}
            </Stack>
          </ScrollArea>

          {picked && (
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
              >
                {projectLinksExpanded ? "Close" : "Project Links"}
              </Button>
            </Stack>
          )}

          <Stack gap={0}>
            <NavLink
              p="md"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/agents" />}
              label="Agents"
            />
            <NavLink
              p="md"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/skills" />}
              label="Skills"
            />
            <NavLink
              p="md"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/files" />}
              label="Files/Memory"
            />
            <NavLink
              p="md"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/data" />}
              label="Structural Data"
            />
            <NavLink
              p="md"
              fw="bold"
              renderRoot={(props) => <Link {...props} to="/errors" />}
              label="Errors"
            />
            <NavLink
              p="md"
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
