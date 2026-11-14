import { ActionIcon, Menu, Tooltip, Box } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconUserCircle } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../api";
import { profileKeys } from "../../../queries";

export function ProfileSwitcher({ onManage }: { onManage: () => void }) {
  const listing = useQuery({
    queryKey: profileKeys.list(),
    queryFn: () => api.listProfiles(),
  });
  const switchTo = useMutation({
    mutationFn: (id: string) => api.switchProfile(id),
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not switch profile",
        message: err.message,
      }),
  });
  const profiles = listing.data?.profiles ?? [];
  const active = profiles.find((p) => p.active);

  return (
    <Menu position="right-end" withArrow shadow="md" width={220}>
      <Menu.Target>
        <Tooltip
          label={active ? `Profile: ${active.name}` : "Profile"}
          position="right"
          withArrow
        >
          <ActionIcon size={40} color="gray" aria-label="Profile">
            <IconUserCircle size={22} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Profile</Menu.Label>
        {profiles.map((p) => (
          <Menu.Item
            key={p.id}
            leftSection={
              p.active ? (
                <IconCheck size={16} />
              ) : (
                <Box component="span" display="inline-block" w={16} />
              )
            }
            {...(p.active ? { "aria-current": "true" as const } : {})}
            onClick={() => {
              if (!p.active) switchTo.mutate(p.id);
            }}
          >
            {p.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item onClick={onManage}>Manage profiles…</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
