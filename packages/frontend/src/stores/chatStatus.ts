import type { Usage } from "@harness/core";
import { create } from "zustand";

/*
 * What the workbench's status bar says about the chat on screen. The chat
 * publishes it while it is mounted; the bar is a read-only summary.
 */

export interface ChatStatus {
  sessionId: string;
  /** The model in use; undefined when the server decides. */
  model: string | undefined;
  /** The latest model call's tokens, live while a reply streams. */
  usage: Usage | undefined;
  /** Tokens used by finished subagent runs, for the meter's tooltip. */
  subagentUsage: Usage | null;
  connected: boolean;
}

interface ChatStatusState {
  status: ChatStatus | null;
  publish: (status: ChatStatus) => void;
  /** Clears the status, unless another chat has replaced it. */
  clear: (sessionId: string) => void;
}

export const useChatStatus = create<ChatStatusState>((set) => ({
  status: null,
  publish: (status) => set({ status }),
  clear: (sessionId) =>
    set((s) => (s.status?.sessionId === sessionId ? { status: null } : s)),
}));
