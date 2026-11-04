import { ScrollArea } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

/** How far from the bottom still counts as being at the bottom, in pixels. */
const NEAR_BOTTOM = 40;

/**
 * The chat transcript's scroll area. It starts at the bottom, and while it is
 * at the bottom it stays there as the content grows (a streaming message, a
 * form opening). Once the reader scrolls up it leaves the position alone, and
 * scrolling back down to the bottom makes it follow again.
 *
 * Whether the reader is at the bottom is checked against the size before the
 * change, so something that scrolls to a message right after this is shown
 * ("Show in transcript") is not pulled back down.
 */
export function TranscriptScroll({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = viewport.current;
    const inner = content.current;
    if (!view || !inner) return;
    view.scrollTop = view.scrollHeight;
    // The sizes as of the last time, to tell where the reader was.
    let height = view.scrollHeight;
    let visible = view.clientHeight;
    // Content growing, or the visible area shrinking (the message box grows).
    const observer = new ResizeObserver(() => {
      const atBottom = height - view.scrollTop - visible <= NEAR_BOTTOM;
      height = view.scrollHeight;
      visible = view.clientHeight;
      if (atBottom) view.scrollTop = height;
    });
    observer.observe(inner);
    observer.observe(view);
    return () => observer.disconnect();
  }, []);

  return (
    <ScrollArea style={{ flex: 1 }} viewportRef={viewport}>
      <div ref={content}>{children}</div>
    </ScrollArea>
  );
}
