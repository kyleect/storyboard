import { notifications } from "@mantine/notifications";

/** A handler for a failed request: shows its message under `title`. */
export const showError = (title: string) => (err: unknown) =>
  notifications.show({
    color: "red",
    title,
    message: err instanceof Error ? err.message : String(err),
  });
