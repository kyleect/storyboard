import {
  AppShell,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "../api";

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

export function Home() {
  return <Text c="dimmed">Create a session or pick one on the left.</Text>;
}
