import { useMantineTheme } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { accentColors, COLORS, PULSE_MS, showIcon } from "../lib/favicon";
import { useActiveRuns } from "./useActiveRuns";
import { useDebouncedFlag } from "./useDebouncedFlag";
import { useUnreadSessions } from "./useUnreadSessions";

/*
 * The tab's icon is a small robot whose accent (eyes, smile, antenna tip) is
 * the app's Mantine primary colour, so it follows the theme. It is drawn from
 * `robotSvg` and set as a data URL. `public/favicon.svg` is the same robot in
 * Mantine's default blue; the page shows it until this hook runs, and it
 * should be redrawn if the default primary colour changes.
 *
 * A dot, lower right, marks three states. To add it the icon is drawn onto a
 * canvas with the dot on top, and the result is set as a PNG data URL. When
 * more than one holds, the first of these wins.
 *
 * - A run waits for the user (an approval or a form; the same signal as the
 *   yellow badge in the app): an orange dot.
 * - A run is working: a gray dot that alternates between gray and dark gray
 *   once a second. A slow beat, because browsers slow timers in background
 *   tabs, which is where the icon matters. With reduced motion it stays gray.
 *   It outranks the next state so that it stays a sign of a run in progress.
 * - A chat has a reply not yet seen: a green dot, as in the app's dots.
 * - Otherwise no dot.
 *
 * The data is `useActiveRuns` and `useUnreadSessions`, so the icon follows the
 * same refreshes as the badges and dots in the app: `runs.changed`, a chat
 * marked seen, and the app-wide stream opening.
 */

type IconState = "idle" | "unread" | "working" | "waiting";

/** `pulseMs` is how long each gray shows; only a test passes it. */
export function useFaviconIndicator(pulseMs = PULSE_MS): void {
  const { eye, tip } = accentColors(useMantineTheme());
  const runs = useActiveRuns().data;
  const hasUnread = useUnreadSessions().count > 0;
  // A brief run would flicker the icon, so the working state is debounced,
  // as it is for the badges.
  const working = useDebouncedFlag((runs?.working ?? 0) > 0);
  const state: IconState =
    (runs?.waiting ?? 0) > 0
      ? "waiting"
      : working
        ? "working"
        : hasUnread
          ? "unread"
          : "idle";
  const reduced = useReducedMotion();

  const [phase, setPhase] = useState<0 | 1>(0);
  useEffect(() => {
    if (state !== "working" || reduced) return;
    const timer = setInterval(
      () => setPhase((p) => (p === 0 ? 1 : 0)),
      pulseMs,
    );
    return () => {
      clearInterval(timer);
      setPhase(0);
    };
  }, [state, reduced, pulseMs]);

  const color =
    state === "waiting"
      ? COLORS.waiting
      : state === "working"
        ? COLORS.working[reduced ? 0 : phase]
        : state === "unread"
          ? COLORS.unread
          : null;

  useEffect(() => showIcon(eye, tip, color), [color, eye, tip]);
}
