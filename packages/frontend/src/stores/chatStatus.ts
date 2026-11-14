import type { Usage } from "@harness/core";
import { create } from "zustand";

export interface ChatStatus {
  sessionId: string;
  model: string | undefined;
  usage: Usage | undefined;
  subagentUsage: Usage | null;
  connected: boolean;
}

interface ChatStatusState {
  status: ChatStatus | null;
  publish: (status: ChatStatus) => void;
  clear: (sessionId: string) => void;
}

export const useChatStatus = create<ChatStatusState>((set) => ({
  status: null,
  publish: (status) => set({ status }),
  clear: (sessionId) =>
    set((s) => (s.status?.sessionId === sessionId ? { status: null } : s)),
}));
