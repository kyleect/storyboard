import { ActionIcon, Stack, Tooltip, useMantineTheme } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBolt,
  IconBox,
  IconDatabase,
  IconFiles,
  IconMessages,
  IconRobot,
  IconSettings,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { RunSummary } from "../../../hooks/useActiveRuns";
import type { WorkbenchKind } from "../../../lib/workbench";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { GlobalRunIndicator, GlobalUnreadIndicator } from "./RunIndicator";

export const RAIL_WIDTH = 52;

interface Item {
  kind: WorkbenchKind;
  label: string;
  icon: ReactNode;
}

const PAGES: Item[] = [
  { kind: "agents", label: "Agents", icon: <IconRobot size={22} /> },
  { kind: "skills", label: "Skills", icon: <IconBolt size={22} /> },
  { kind: "files", label: "Files", icon: <IconFiles size={22} /> },
  {
    kind: "data",
    label: "Structured data",
    icon: <IconDatabase size={22} />,
  },
  { kind: "workspaces", label: "Workspaces", icon: <IconBox size={22} /> },
  {
    kind: "errors",
    label: "Errors",
    icon: <IconAlertTriangle size={22} />,
  },
];

export function Rail({
  activeKind,
  chatsOpen,
  onChats,
  onOpen,
  onManageProfiles,
  activity,
  unread,
}: {
  activeKind: WorkbenchKind | null;
  chatsOpen: boolean;
  onChats: () => void;
  onOpen: (kind: WorkbenchKind) => void;
  onManageProfiles: () => void;
  activity: RunSummary | undefined;
  unread: number | undefined;
}) {
  const theme = useMantineTheme();

  const button = (
    item: Item,
    active: boolean,
    onClick: () => void,
    expanded?: boolean,
  ) => {
    return (
      <Tooltip key={item.kind} label={item.label} position="right" withArrow>
        <ActionIcon
          size={40}
          variant={active ? "light" : "subtle"}
          color={active ? theme.primaryColor : "gray"}
          aria-label={item.label}
          {...(expanded === undefined
            ? active
              ? { "aria-current": "page" as const }
              : {}
            : { "aria-expanded": expanded })}
          onClick={onClick}
        >
          {item.icon}
        </ActionIcon>
      </Tooltip>
    );
  };

  return (
    <Stack
      component="nav"
      aria-label="Pages"
      gap={4}
      align="center"
      w={RAIL_WIDTH}
      style={{
        flexShrink: 0,
        padding: "8px 0",
        borderRight: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Stack gap={4} align="center" flex={1}>
        {button(
          { kind: "chat", label: "Chats", icon: <IconMessages size={22} /> },
          chatsOpen,
          onChats,
          chatsOpen,
        )}
        <GlobalRunIndicator summary={activity} />
        <GlobalUnreadIndicator count={unread} />
        {PAGES.map((p) =>
          button(p, activeKind === p.kind, () => onOpen(p.kind)),
        )}
      </Stack>
      <Stack gap={4} align="center">
        <ProfileSwitcher onManage={onManageProfiles} />
        {button(
          {
            kind: "settings",
            label: "Settings",
            icon: <IconSettings size={22} />,
          },
          activeKind === "settings",
          () => onOpen("settings"),
        )}
      </Stack>
    </Stack>
  );
}
