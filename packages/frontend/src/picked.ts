import { create } from "zustand";

/*
 * The project picked in the navbar (sessions and projects design, Q13).
 * null: No project (standalone sessions). Remembered in localStorage for
 * this browser; the navbar resets it when the project is gone.
 */

const KEY = "harness.pickedProject";

function load(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function save(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
}

interface PickedState {
  projectId: string | null;
  pick: (projectId: string | null) => void;
}

export const usePicked = create<PickedState>((set) => ({
  projectId: load(),
  pick: (projectId) => {
    save(projectId);
    set({ projectId });
  },
}));
