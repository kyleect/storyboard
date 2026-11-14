import { create } from "zustand";
import type {
  ApprovalRequest,
  ContentBlock,
  InputRequest,
  RunAgent,
  Usage,
} from "@harness/core";

export interface LiveMessage {
  messageId: string;
  continuing: boolean;
  content: readonly ContentBlock[];
}

export interface LiveRunState {
  runId: string;
  model: string | null;
  reasoningEffort: string | null;
  agent: RunAgent | null;
  message: LiveMessage | null;
  approvals: ApprovalRequest[];
  inputs: InputRequest[];
  userMessages: string[];
  usage?: Usage;
}

export interface LiveRun extends LiveRunState {
  children: Record<string, LiveChild>;
}

export interface LiveChild extends LiveRunState {
  parentRunId: string;
  parentCallId: string;
}

export function liveRuns(run: LiveRun | undefined): LiveRunState[] {
  return run ? [run, ...Object.values(run.children)] : [];
}

export function findLiveRun(
  run: LiveRun | undefined,
  runId: string | null,
): LiveRunState | undefined {
  if (!run) return undefined;

  return (runId !== null ? run.children[runId] : undefined) ?? run;
}

interface LiveState {
  runs: Record<string, LiveRun | undefined>;
  connected: Record<string, boolean | undefined>;
  set: (sessionId: string, run: LiveRun | undefined) => void;
  update: (
    sessionId: string,
    runId: string | null,
    f: (run: LiveRunState) => LiveRunState,
  ) => void;
  addChild: (sessionId: string, child: LiveChild) => void;
  removeChild: (sessionId: string, runId: string) => void;
  setConnected: (sessionId: string, connected: boolean) => void;
}

export const useLive = create<LiveState>((set) => ({
  runs: {},
  connected: {},
  set: (sessionId, run) =>
    set((s) => ({ runs: { ...s.runs, [sessionId]: run } })),
  update: (sessionId, runId, f) =>
    set((s) => {
      const run = s.runs[sessionId];

      if (!run) return s;

      const child = runId !== null ? run.children[runId] : undefined;
      const next: LiveRun = child
        ? {
            ...run,
            children: {
              ...run.children,
              [child.runId]: { ...child, ...f(child) },
            },
          }
        : { ...run, ...f(run) };

      return { runs: { ...s.runs, [sessionId]: next } };
    }),
  addChild: (sessionId, child) =>
    set((s) => {
      const run = s.runs[sessionId];

      return run
        ? {
            runs: {
              ...s.runs,
              [sessionId]: {
                ...run,
                children: { ...run.children, [child.runId]: child },
              },
            },
          }
        : s;
    }),
  removeChild: (sessionId, runId) =>
    set((s) => {
      const run = s.runs[sessionId];

      if (!run?.children[runId]) return s;

      const children = Object.fromEntries(
        Object.entries(run.children).filter(([id]) => id !== runId),
      );

      return { runs: { ...s.runs, [sessionId]: { ...run, children } } };
    }),
  setConnected: (sessionId, connected) =>
    set((s) => ({ connected: { ...s.connected, [sessionId]: connected } })),
}));
