import { useQuery } from "@tanstack/react-query";
import { api, type ActiveRun } from "../api";
import { runKeys } from "../queries";

/*
 * The activity indicators: which runs are in progress, in any session. The
 * data is the backend's `GET /api/runs/active`, refetched on `runs.changed`
 * and whenever the app-wide stream opens (`useAppEvents`). It is server
 * data, so it lives in the query cache, not in `useLive`.
 */

/** How a session's runs are doing: working, or waiting for the user. */
export type SessionRunState = "running" | "waiting";

export interface RunSummary {
  /** Every run in progress, oldest first. */
  runs: ActiveRun[];
  /** How many runs are working (not waiting for the user). */
  working: number;
  /** How many runs wait for an approval or a form. */
  waiting: number;
  /** By session id; a session with no run in progress is not listed. */
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

/** The runs in progress in every session. `data` is empty until it loads. */
export function useActiveRuns() {
  return useQuery({
    queryKey: runKeys.active(),
    queryFn: api.listActiveRuns,
    select,
  });
}
