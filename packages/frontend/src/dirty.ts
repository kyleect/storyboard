import { createContext, useContext, useEffect } from "react";
import { create } from "zustand";

/*
 * Which workbench tabs have unsaved edits. A page in a tab reports its own
 * (`useReportDirty`); the workbench keeps such a tab mounted when it is not
 * the active one, asks before closing it, and asks before the page is
 * reloaded. A page shown outside a tab reports nothing.
 */

/** The id of the tab a page is shown in; null outside the workbench. */
export const TabIdContext = createContext<string | null>(null);

interface DirtyState {
  dirty: Record<string, true>;
  set: (id: string, on: boolean) => void;
}

export const useDirtyTabs = create<DirtyState>((set) => ({
  dirty: {},
  set: (id, on) =>
    set((s) => {
      if (on === (s.dirty[id] === true)) return s;
      if (on) return { dirty: { ...s.dirty, [id]: true } };
      return {
        dirty: Object.fromEntries(
          Object.entries(s.dirty).filter(([k]) => k !== id),
        ),
      };
    }),
}));

/** Reports whether the page in this tab has unsaved edits. */
export function useReportDirty(dirty: boolean): void {
  const id = useContext(TabIdContext);
  const set = useDirtyTabs((s) => s.set);
  useEffect(() => {
    if (id === null) return;
    set(id, dirty);
    return () => set(id, false);
  }, [id, dirty, set]);
}
