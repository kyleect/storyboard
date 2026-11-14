import { useMantineTheme } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { accentColors, COLORS, PULSE_MS, showIcon } from "../lib/favicon";
import { useActiveRuns } from "./useActiveRuns";
import { useDebouncedFlag } from "./useDebouncedFlag";
import { useUnreadSessions } from "./useUnreadSessions";

type IconState = "idle" | "unread" | "working" | "waiting";

export function useFaviconIndicator(pulseMs = PULSE_MS): void {
  const { eye, tip } = accentColors(useMantineTheme());
  const runs = useActiveRuns().data;
  const hasUnread = useUnreadSessions().count > 0;
  // A brief run would flicker the icon, so the working state is debounced,
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
