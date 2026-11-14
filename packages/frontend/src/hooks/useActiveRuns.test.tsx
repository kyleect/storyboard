import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRun } from "../api";
import { summarizeRuns } from "./useActiveRuns";
import { useDebouncedFlag } from "./useDebouncedFlag";

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId: "r1",
  sessionId: "s1",
  sessionTitle: "T",
  parentRunId: null,
  agentName: null,
  waiting: false,
  ...over,
});

describe("summarizeRuns", () => {
  it("is empty when nothing runs", () => {
    expect(summarizeRuns([])).toEqual({
      runs: [],
      working: 0,
      waiting: 0,
      bySession: {},
    });
  });

  it("counts working and waiting runs, subagents included", () => {
    const s = summarizeRuns([
      run(),
      run({ runId: "r2", parentRunId: "r1" }),
      run({ runId: "r3", sessionId: "s2", waiting: true }),
    ]);

    expect(s.working).toBe(2);
    expect(s.waiting).toBe(1);
    expect(s.bySession).toEqual({ s1: "running", s2: "waiting" });
  });

  it("shows a session as waiting when any of its runs waits, in either order", () => {
    const working = run();
    const waiting = run({ runId: "r2", parentRunId: "r1", waiting: true });

    expect(summarizeRuns([working, waiting]).bySession).toEqual({
      s1: "waiting",
    });
    expect(summarizeRuns([waiting, working]).bySession).toEqual({
      s1: "waiting",
    });
  });
});

describe("useDebouncedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () =>
    renderHook(({ active }) => useDebouncedFlag(active), {
      initialProps: { active: false },
    });
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("shows only after the delay", () => {
    const { result, rerender } = setup();

    rerender({ active: true });
    advance(299);
    expect(result.current).toBe(false);
    advance(1);
    expect(result.current).toBe(true);
  });

  it("never shows for a run shorter than the delay", () => {
    const { result, rerender } = setup();

    rerender({ active: true });
    advance(100);
    rerender({ active: false });
    advance(2000);
    expect(result.current).toBe(false);
  });

  it("stays for the minimum time once shown", () => {
    const { result, rerender } = setup();

    rerender({ active: true });
    advance(300);
    advance(100);
    rerender({ active: false });
    advance(499);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });

  it("does not flicker between back-to-back runs", () => {
    const { result, rerender } = setup();

    rerender({ active: true });
    advance(300);
    rerender({ active: false });
    advance(100);
    rerender({ active: true });
    advance(5000);
    expect(result.current).toBe(true);
  });
});
