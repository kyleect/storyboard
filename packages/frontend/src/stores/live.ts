import { create } from "zustand";
import type {
  ApprovalRequest,
  ContentBlock,
  InputRequest,
  RunAgent,
  Usage,
} from "@harness/core";

/*
 * The in-flight run of each session, built from streamed events. A run can
 * write several messages (tools design, section 4): each finished message
 * goes into the cached transcript, tool results are refetched, and when the
 * run ends the transcript is refetched and the live file cleared.
 */

export interface LiveMessage {
  messageId: string;
  continuing: boolean;
  content: readonly ContentBlock[];
}

/** What is tracked for each run in progress. */
export interface LiveRunState {
  runId: string;
  model: string | null;
  reasoningEffort: string | null;
  /** The agent version the run uses; null: none. */
  agent: RunAgent | null;
  /** The message being written now; null while a tool runs. */
  message: LiveMessage | null;
  /** Approval requests waiting for an answer, oldest first. */
  approvals: ApprovalRequest[];
  /** Forms waiting for an answer, oldest first (input forms design). */
  inputs: InputRequest[];
  /** Messages the user sent that the run has not read yet, oldest first. */
  userMessages: string[];
  /** The latest running token count from the stream. */
  usage?: Usage;
}

/** The session's top-level run, with the subagents' runs it started. */
export interface LiveRun extends LiveRunState {
  /** Subagents' runs in progress, by run id (agent delegation design). */
  children: Record<string, LiveChild>;
}

/** A subagent's run, tied to the call that started it. */
export interface LiveChild extends LiveRunState {
  parentRunId: string;
  parentCallId: string;
}

/** The runs of a session in progress, the top-level one first. */
export function liveRuns(run: LiveRun | undefined): LiveRunState[] {
  return run ? [run, ...Object.values(run.children)] : [];
}

/** The run with this id, top-level or a subagent's. */
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
  /**
   * Changes the run `runId` names: a subagent's, or else the top-level run
   * (events of a run that is not known apply to the top-level one).
   */
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
