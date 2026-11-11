import { useBlocker } from "@tanstack/react-router";

/**
 * Asks before the page is left or reloaded. Render it only while there are
 * unsaved edits in an explorer view; it is its own component so the router's
 * blocker is used only then.
 */
export function LeaveGuard({ label = "Files" }: { label?: string }) {
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm(`You have unsaved changes in ${label}. Leave anyway?`),
    enableBeforeUnload: true,
  });
  return null;
}
