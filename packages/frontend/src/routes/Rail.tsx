import { ActionIcon, Box, Stack, Tooltip } from "@mantine/core";
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
import type { RunSummary } from "../runs";
import type { WorkbenchKind } from "../workbench";
import { GlobalRunIndicator } from "./RunIndicator";

/*
 * The icon rail at the left of the workbench: the pages that are not about
 * one chat or project, each opening as a tab, and Settings at the bottom.
 * "Chats" shows and hides the list of chats; the others open a page in a
 * preview tab.
 */

export const RAIL_WIDTH = 52;

interface Item {
  kind: WorkbenchKind;
  label: string;
  icon: ReactNode;
}

const PAGES: Item[] = [
  { kind: "agents", label: "Agents", icon: <IconRobot size={22} /> },
  { kind: "skills", label: "Skills", icon: <IconBolt size={22} /> },
  { kind: "files", label: "Files & memory", icon: <IconFiles size={22} /> },
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
  activity,
}: {
  /** The kind of the active tab, to mark its item. */
  activeKind: WorkbenchKind | null;
  /** The chats tree is shown; "Chats" shows and hides it. */
  chatsOpen: boolean;
  onChats: () => void;
  onOpen: (kind: WorkbenchKind) => void;
  activity: RunSummary | undefined;
}) {
  const button = (
    item: Item,
    active: boolean,
    onClick: () => void,
    expanded?: boolean,
  ) => (
    <Tooltip key={item.kind} label={item.label} position="right" withArrow>
      <ActionIcon
        size={40}
        variant={active ? "light" : "subtle"}
        color={active ? "blue" : "gray"}
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

  return (
    <Box
      component="nav"
      aria-label="Pages"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: "8px 0",
        borderRight: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Stack gap={4} align="center" style={{ flex: 1 }}>
        {button(
          { kind: "chat", label: "Chats", icon: <IconMessages size={22} /> },
          chatsOpen,
          onChats,
          chatsOpen,
        )}
        <GlobalRunIndicator summary={activity} />
        {PAGES.map((p) =>
          button(p, activeKind === p.kind, () => onOpen(p.kind)),
        )}
      </Stack>
      <Stack>
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
    </Box>
  );
}
