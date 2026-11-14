import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Box,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ProfileView } from "../../../api";
import { profileKeys } from "../../../queries";

export function Profiles() {
  const queryClient = useQueryClient();
  const listing = useQuery({
    queryKey: profileKeys.list(),
    queryFn: () => api.listProfiles(),
  });
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: profileKeys.all });
  const onError = (title: string) => (err: Error) =>
    notifications.show({ color: "red", title, message: err.message });

  const create = useMutation({
    mutationFn: (n: string) => api.createProfile(n),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: onError("Could not create the profile"),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api.renameProfile(v.id, v.name),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError: onError("Could not rename the profile"),
  });
  const trash = useMutation({
    mutationFn: (id: string) => api.trashProfile(id),
    onSuccess: refresh,
    onError: onError("Could not trash the profile"),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreProfile(id),
    onSuccess: refresh,
    onError: onError("Could not restore the profile"),
  });
  const switchTo = useMutation({
    mutationFn: (id: string) => api.switchProfile(id),
    onError: onError("Could not switch profile"),
  });

  if (listing.isPending) return <Loader size="sm" />;
  if (listing.isError) {
    return <Text c="red">{listing.error.message}</Text>;
  }
  const { profiles, trashed } = listing.data;

  const row = (p: ProfileView) => (
    <Paper key={p.id} p="sm">
      <Group justify="space-between" wrap="nowrap">
        {editing?.id === p.id ? (
          <Box
            component="form"
            flex={1}
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate({ id: p.id, name: editing.name });
            }}
          >
            <Group gap="xs" wrap="nowrap">
              <TextInput
                aria-label="Profile name"
                value={editing.name}
                onChange={(e) =>
                  setEditing({ id: p.id, name: e.currentTarget.value })
                }
                data-autofocus
                flex={1}
              />
              <Button type="submit" size="xs" loading={rename.isPending}>
                Save
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </Group>
          </Box>
        ) : (
          <>
            <Group gap="xs">
              <Text fw={500}>{p.name}</Text>
              {p.active && <Badge size="md">Active</Badge>}
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="default"
                disabled={p.active}
                loading={switchTo.isPending && switchTo.variables === p.id}
                onClick={() => switchTo.mutate(p.id)}
              >
                Switch to
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={() => setEditing({ id: p.id, name: p.name })}
              >
                Rename
              </Button>
              <Button
                size="xs"
                variant="default"
                color="red"
                disabled={p.active || p.id === "default"}
                onClick={() => trash.mutate(p.id)}
              >
                Trash
              </Button>
            </Group>
          </>
        )}
      </Group>
    </Paper>
  );

  return (
    <Stack>
      <div>
        <Title order={4}>Profiles</Title>
        <Text size="sm" c="dimmed">
          Each profile is a workspace of its own: its agents, skills, files,
          structured data, projects, chats, settings, MCP servers and
          workspaces. Built-in agents, skills and schemas are in every profile.
          A profile cannot be switched while a run is active.
        </Text>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== "") create.mutate(name);
        }}
      >
        <Group align="flex-end" gap="xs">
          <TextInput
            label="New profile"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            flex={1}
          />
          <Button
            type="submit"
            loading={create.isPending}
            disabled={name.trim() === ""}
          >
            Create
          </Button>
        </Group>
      </form>

      <Stack gap="xs">{profiles.map(row)}</Stack>

      {trashed.length > 0 && (
        <Stack gap="xs">
          <Title order={5}>In the trash</Title>
          {trashed.map((p) => (
            <Paper key={p.id} p="sm">
              <Group justify="space-between">
                <Text c="dimmed">{p.name}</Text>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => restore.mutate(p.id)}
                >
                  Restore
                </Button>
              </Group>
            </Paper>
          ))}
          <Text size="xs" c="dimmed">
            A trashed profile keeps all its data and cannot be switched to until
            it is restored.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
