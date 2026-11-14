import { Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import utils from "../styles/utilities.module.css";

export function PaneHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Group
      px="xs"
      py={4}
      gap={0}
      justify="space-between"
      wrap="nowrap"
      className={utils.borderBottom}
    >
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" lts="0.5px">
        {title}
      </Text>
      <Group gap={2} wrap="nowrap">
        {children}
      </Group>
    </Group>
  );
}
