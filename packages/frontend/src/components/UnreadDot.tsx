import { Led } from "@gfazioli/mantine-led";

export function UnreadDot({ label = "New reply" }: { label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}
    >
      <Led color="green" size="xs" />
    </span>
  );
}
