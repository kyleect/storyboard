import { useBlocker } from "@tanstack/react-router";

/**
 * Asks before the page is left or reloaded. Render it only while there are
 * unsaved edits in the Files view; it is its own component so the router's
 * blocker is used only then.
 */
export function LeaveGuard() {
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm("You have unsaved changes in Files. Leave anyway?"),
    enableBeforeUnload: true,
  });
  return null;
}
