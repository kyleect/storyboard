import { useQuery } from "@tanstack/react-query";
import { api, type ActiveRun } from "../api";
import { runKeys } from "../queries";

export type SessionRunState = "running" | "waiting";

export interface RunSummary {
  runs: ActiveRun[];
  working: number;
  waiting: number;
  bySession: Record<string, SessionRunState>;
}

/**
 * Counts runs, subagents' included. A session shows as waiting when any of
 * its runs waits, because that is the one that needs the user.
 */
export function summarizeRuns(runs: readonly ActiveRun[]): RunSummary {
  const bySession: Record<string, SessionRunState> = {};
  let waiting = 0;

  for (const run of runs) {
    if (run.waiting) waiting += 1;

    if (run.waiting || bySession[run.sessionId] === undefined) {
      bySession[run.sessionId] = run.waiting ? "waiting" : "running";
    }
  }

  return {
    runs: [...runs],
    working: runs.length - waiting,
    waiting,
    bySession,
  };
}

const select = (data: { runs: ActiveRun[] }) => summarizeRuns(data.runs);

export function useActiveRuns() {
  return useQuery({
    queryKey: runKeys.active(),
    queryFn: api.listActiveRuns,
    select,
  });
}
