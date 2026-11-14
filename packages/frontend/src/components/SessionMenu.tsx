import { ActionIcon, Menu } from "@mantine/core";
import type { Session } from "../api";
import { useSessionActions } from "../hooks/useSessionActions";

/** The ⋯ menu on a session's entry: Rename, Move to trash. */
export function SessionMenu({ session }: { session: Session }) {
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
      {/* The menu is drawn elsewhere, but its clicks still reach the row. */}
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
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
