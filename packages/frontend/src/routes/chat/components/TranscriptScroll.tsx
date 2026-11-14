import { ScrollArea } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

const NEAR_BOTTOM = 40;

export function TranscriptScroll({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = viewport.current;
    const inner = content.current;
    if (!view || !inner) return;
    view.scrollTop = view.scrollHeight;
    let height = view.scrollHeight;
    let visible = view.clientHeight;
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
