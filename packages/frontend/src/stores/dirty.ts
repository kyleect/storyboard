import { createContext, useContext, useEffect } from "react";
import { create } from "zustand";

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

export function useReportDirty(dirty: boolean): void {
  const id = useContext(TabIdContext);
  const set = useDirtyTabs((s) => s.set);
  useEffect(() => {
    if (id === null) return;
    set(id, dirty);
    return () => set(id, false);
  }, [id, dirty, set]);
}
