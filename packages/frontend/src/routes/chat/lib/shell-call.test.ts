import { describe, expect, it } from "vitest";
import {
  outcomeText,
  readShellCall,
  readShellOutcome,
  type ShellOutcome,
} from "./shell-call";

const outcome = (over: Partial<ShellOutcome> = {}): ShellOutcome => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 250,
  workspace: "Book",
  folder: "",
  timeoutSeconds: 120,
  output: "",
  notice: undefined,
  ...over,
});

describe("readShellCall", () => {
  it("reads the arguments as an object or as JSON text", () => {
    const expected = {
      command: "ls\npwd",
      cwd: "/home/kim/book/src",
      timeoutSeconds: 30,
      description: "List",
    };
    const args = {
      command: "ls\npwd",
      cwd: "/home/kim/book/src",
      timeout_seconds: 30,
      description: "List",
    };

    expect(readShellCall(args)).toEqual(expected);
    expect(readShellCall(JSON.stringify(args))).toEqual(expected);
  });

  it("fills in what is left out, and ignores a blank description", () => {
    expect(readShellCall({ command: "ls", description: "  " })).toEqual({
      command: "ls",
      cwd: "",
      timeoutSeconds: undefined,
      description: undefined,
    });
  });

  it("is not a shell call without a command", () => {
    expect(readShellCall({ cwd: "x" })).toBeUndefined();
    expect(readShellCall("{ not json")).toBeUndefined();
    expect(readShellCall(null)).toBeUndefined();
    expect(readShellCall([1])).toBeUndefined();
  });
});

describe("readShellOutcome", () => {
  it("reads a result", () => {
    expect(
      readShellOutcome({
        exitCode: 2,
        signal: null,
        timedOut: false,
        durationMs: 40,
        workspace: "Book",
        folder: "src",
        timeoutSeconds: 120,
        output: "boom\n",
        notice: "lowered",
      }),
    ).toEqual(
      outcome({
        exitCode: 2,
        durationMs: 40,
        folder: "src",
        output: "boom\n",
        notice: "lowered",
      }),
    );
  });

  it("is not a result when the shape does not fit", () => {
    expect(readShellOutcome(undefined)).toBeUndefined();
    expect(readShellOutcome({ output: 1 })).toBeUndefined();
    expect(readShellOutcome({ output: "x", timedOut: false })).toBeUndefined();
  });
});

describe("outcomeText", () => {
  it("says the exit code and how long it took", () => {
    expect(outcomeText(outcome())).toBe("Exit code 0 after 250 ms");
    expect(outcomeText(outcome({ exitCode: 1, durationMs: 2500 }))).toBe(
      "Exit code 1 after 2.5 s",
    );
  });

  it("says when the time limit or a signal ended it", () => {
    expect(outcomeText(outcome({ timedOut: true, exitCode: null }))).toBe(
      "Ended at the time limit of 120 s after 250 ms",
    );
    expect(outcomeText(outcome({ exitCode: null, signal: "SIGTERM" }))).toBe(
      "Ended by SIGTERM after 250 ms",
    );
  });
});
