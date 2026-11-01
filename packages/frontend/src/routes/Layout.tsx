import {
  ActionIcon,
  AppShell,
  Button,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { api, type Session } from "../api";
import { useSessionActions } from "./SessionActions";

export function Layout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: api.listSessions,
  });

  const create = useMutation({
    mutationFn: () => api.createSession(),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: session.id },
      });
    },
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
          <ScrollArea style={{ flex: 1 }}>
            {sessions.isError && (
              <Text c="red" size="sm">
                {sessions.error.message}
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
                rightSection={<SessionMenu session={s} />}
              />
            ))}
          </ScrollArea>
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

/** The ⋯ menu on a session's navbar entry: Rename, Move to trash. */
function SessionMenu({ session }: { session: Session }) {
  const actions = useSessionActions();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Actions for ${session.title}`}
          // The entry is a link; the menu must not follow it.
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ⋯
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => actions.openRename(session)}>
          Rename
        </Menu.Item>
        <Menu.Item color="red" onClick={() => actions.confirmTrash(session)}>
          Move to trash
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function Home() {
  return <Text c="dimmed">Create a session or pick one on the left.</Text>;
}
