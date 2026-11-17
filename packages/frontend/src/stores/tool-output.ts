import { create } from "zustand";

/*
 * The output a running tool has sent so far (`tool.update`), by call id. It is
 * kept only while the call runs: the tool result replaces it, and a page that
 * is opened later shows what arrives from then on.
 */

/** The most characters kept for one call; the tool's own cap is lower. */
const MAX_CHARS = 100_000;

interface ToolOutputState {
  byCall: Record<string, string | undefined>;
  append: (callId: string, text: string) => void;
  clear: (callId: string) => void;
}

export const useToolOutput = create<ToolOutputState>((set) => ({
  byCall: {},
  append: (callId, text) =>
    set((s) => {
      const next = (s.byCall[callId] ?? "") + text;

      return {
        byCall: {
          ...s.byCall,
          [callId]: next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next,
        },
      };
    }),
  clear: (callId) =>
    set((s) => {
      if (s.byCall[callId] === undefined) return s;

      const rest = Object.fromEntries(
        Object.entries(s.byCall).filter(([id]) => id !== callId),
      );

      return { byCall: rest };
    }),
}));
