import { create } from "zustand";

/*
 * A request to show an agent at one of its versions: the badge on a chat
 * message makes it, and the Agents view takes it, opening the agent's tab
 * and its Versions list on that version. Nothing is kept: it is a message
 * between two places in the app, not state.
 */

export interface AgentFocus {
  agentId: string;
  version: number;
  /** The agent's project; null for a global agent. */
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
