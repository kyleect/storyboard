import { create } from "zustand";

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export type Direction = "asc" | "desc";

const KEY = "harness.sessionsPrefs";

interface Saved {
  direction: Direction;
  pageSize: PageSize;
}

const DEFAULTS: Saved = { direction: "desc", pageSize: 10 };

function isPageSize(value: unknown): value is PageSize {
  return PAGE_SIZES.some((size) => size === value);
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);

    if (raw === null) return DEFAULTS;

    const saved = JSON.parse(raw) as Partial<Saved> | null;

    return {
      direction: saved?.direction === "asc" ? "asc" : DEFAULTS.direction,
      pageSize: isPageSize(saved?.pageSize)
        ? saved.pageSize
        : DEFAULTS.pageSize,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage can be unavailable
  }
}

interface PrefsState extends Saved {
  setDirection: (direction: Direction) => void;
  setPageSize: (pageSize: PageSize) => void;
}

export const useSessionsPrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setDirection: (direction) => {
    save({ direction, pageSize: get().pageSize });
    set({ direction });
  },
  setPageSize: (pageSize) => {
    save({ direction: get().direction, pageSize });
    set({ pageSize });
  },
}));
