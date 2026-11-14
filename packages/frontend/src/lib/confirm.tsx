import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { ReactNode } from "react";

interface ConfirmOptions {
  title: ReactNode;
  message: ReactNode;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function confirmAction({
  title,
  message,
  confirm,
  cancel = "Cancel",
  danger = false,
  onConfirm,
}: ConfirmOptions) {
  modals.openConfirmModal({
    title,
    children: <Text size="sm">{message}</Text>,
    labels: { confirm, cancel },
    ...(danger && { confirmProps: { color: "red" } }),
    onConfirm,
  });
}
