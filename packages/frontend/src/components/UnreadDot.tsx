import { Center } from "@mantine/core";
import { Led } from "@gfazioli/mantine-led";

export function UnreadDot({ label = "New reply" }: { label?: string }) {
  return (
    <Center inline flex="none" role="img" aria-label={label} title={label}>
      <Led color="green" size="xs" />
    </Center>
  );
}
