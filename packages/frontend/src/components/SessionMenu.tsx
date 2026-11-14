import { ActionIcon, Menu } from "@mantine/core";
import type { ReactNode } from "react";
import type { Session } from "../api";
import { useSessionActions } from "../hooks/useSessionActions";

export type SessionActions = ReturnType<typeof useSessionActions>;

export function SessionMenuItems({
  session,
  actions,
}: {
  session: Session;
  actions: SessionActions;
}) {
  return (
    <>
      <Menu.Item onClick={() => actions.openRename(session)}>Rename</Menu.Item>
      <Menu.Item color="red" onClick={() => actions.confirmTrash(session)}>
        Move to trash
      </Menu.Item>
    </>
  );
}

export function SessionMenu({
  session,
  extra,
}: {
  session: Session;
  extra?: ReactNode;
}) {
  const actions = useSessionActions();

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Actions for ${session.title}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ⋯
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
        <SessionMenuItems session={session} actions={actions} />
        {extra}
      </Menu.Dropdown>
    </Menu>
  );
}
