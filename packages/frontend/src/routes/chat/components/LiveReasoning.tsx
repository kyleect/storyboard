import {
  Group,
  Stack,
  Text,
  UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import { useState } from "react";
import { type Usage } from "@harness/core";

/**
 * Reasoning still being written: collapsed to its latest line and the
 * running token count, with the full text one click away.
 */
export function LiveReasoning({
  text,
  usage,
}: {
  text: string;
  usage: Usage | undefined;
}) {
  const [open, setOpen] = useState(false);
  const theme = useMantineTheme();
  const latest =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return (
    <Stack gap={2}>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Reasoning…
          {usage ? ` ${usage.completionTokens} tokens` : ""}
        </Text>
        <UnstyledButton onClick={() => setOpen((o) => !o)}>
          <Text size="xs" c={theme.primaryColor}>
            {open ? "Hide" : "Show all"}
          </Text>
        </UnstyledButton>
      </Group>
      {open ? (
        <Text
          size="sm"
          c="dimmed"
          fs="italic"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {text}
        </Text>
      ) : (
        <Text size="sm" c="dimmed" fs="italic" lineClamp={1}>
          {latest}
        </Text>
      )}
    </Stack>
  );
}
