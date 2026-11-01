import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type ToolContext,
} from "@harness/core";
import { currentDate, currentTime } from "./clock.js";

const ctx: ToolContext = {
  signal: new AbortController().signal,
  sessionId: "s",
  runId: "r",
  callId: "c",
  update: () => {},
  requestInput: () => Promise.reject(new Error("Not used here.")),
  state: undefined,
  projectId: null,
  entries: createEntryAccess({
    session: replaySessionEntries([]),
    sessionOps: [],
    inProject: false,
    author: { by: "model", sessionId: "s", runId: "r" },
  }),
};
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  vi.useRealTimers();
});

describe("clock tools", () => {
  it("current_date returns the local date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 23, 59, 30));
    expect(await currentDate.execute({}, ctx)).toEqual({
      data: { date: "2026-01-05", timeZone: zone },
    });
  });

  it("current_time returns the local time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 9, 5, 3));
    expect(await currentTime.execute({}, ctx)).toEqual({
      data: { time: "09:05:03", timeZone: zone },
    });
  });

  it("take no arguments and run without asking", () => {
    for (const tool of [currentDate, currentTime]) {
      expect(tool.approval).toBe("never");
      expect(tool.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(tool.parse({})).toEqual({ ok: true, input: {} });
    }
  });
});
