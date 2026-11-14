import { Led } from "@gfazioli/mantine-led";

/*
 * The dot for a reply the user has not seen yet: on open tabs and beside the
 * chats of the Sessions table. It stands still when the user prefers reduced
 * motion, as the spinner in RunIndicator does.
 */

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
