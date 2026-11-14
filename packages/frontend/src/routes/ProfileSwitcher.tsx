import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconUserCircle } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { profileKeys } from "../queries";

/*
 * The profile switcher at the bottom of the rail (profiles design 4.3). A
 * profile is a whole workspace of its own, so choosing one replaces what every
 * page shows. The switch itself is announced to every window on the app-wide
 * stream, which resets this one; the backend refuses it while a run is active,
 * and the reason is shown here.
 */
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
          <ActionIcon
            size={40}
            variant="subtle"
            color="gray"
            aria-label="Profile"
          >
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
                <span style={{ display: "inline-block", width: 16 }} />
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
