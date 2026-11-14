import { create } from "zustand";

export interface AgentFocus {
  agentId: string;
  version: number;
  projectId: string | null;
}

interface AgentFocusState {
  request: AgentFocus | null;
  ask: (f: AgentFocus) => void;
  clear: () => void;
}

export const useAgentFocus = create<AgentFocusState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
