import { describe, expect, it } from "vitest";
import {
  createFileAccess,
  replaySessionFiles,
  NO_AGENTS,
  NO_DATA,
  NO_PROJECTS,
  NO_SKILL_FILES,
  NO_SUBAGENTS,
  ShellError,
  WorkspaceError,
  type ShellAccess,
  type ShellRequest,
  type ShellResult,
  type ToolContext,
  type WorkspaceInfo,
} from "@harness/core";
import { outputText, shellRun } from "./shell.js";

const BOOK = "/home/kim/book";
const book: WorkspaceInfo = {
  id: "w1",
  name: "Book",
  path: BOOK,
  writable: true,
};
const archive: WorkspaceInfo = {
  id: "w2",
  name: "Archive",
  path: "/home/kim/archive",
  writable: false,
};

/** Finds the workspace whose folder holds a full path, as the backend does. */
const locateIn =
  (list: WorkspaceInfo[]): ShellAccess["locate"] =>
  (text) => {
    const workspace = list.find(
      (w) => text === w.path || text.startsWith(`${w.path}/`),
    );
    return workspace
      ? {
          workspace,
          path: text.slice(workspace.path.length).replace(/^\//, ""),
          cwd: text,
        }
      : { error: `${text} is not inside a workspace.` };
  };

const done: ShellResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 12,
  output: "ok\n",
  cutChars: 0,
  cutAt: 0,
};

function fakeShell(
  result: ShellResult | Error = done,
  limits = { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 600 },
  list: WorkspaceInfo[] = [book],
) {
  const calls: { request: ShellRequest; signal: AbortSignal }[] = [];
  let emit: (text: string) => void = () => {};
  const access: ShellAccess = {
    ...limits,
    locate: locateIn(list),
    run: (request, io) => {
      calls.push({ request, signal: io.signal });
      emit = io.onOutput;
      io.onOutput("live ");
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    },
  };
  return { access, calls, emit: (t: string) => emit(t) };
}

function ctxOf(
  shell: ShellAccess | undefined,
  updates: string[] = [],
  signal = new AbortController().signal,
): ToolContext {
  return {
    signal,
    sessionId: "s",
    runId: "r",
    callId: "c",
    update: (text) => updates.push(text),
    requestInput: () => Promise.reject(new Error("Not used here.")),
    state: undefined,
    projectId: null,
    projectName: null,
    projects: NO_PROJECTS,
    agents: NO_AGENTS,
    subagents: NO_SUBAGENTS,
    data: NO_DATA,
    copyLimit: 20,
    skills: [],
    skillFiles: NO_SKILL_FILES,
    files: createFileAccess({
      session: replaySessionFiles([]),
      sessionOps: [],
      inProject: false,
      author: { by: "model", sessionId: "s", runId: "r" },
    }),
    ...(shell ? { shell } : {}),
  };
}

const call = (input: unknown, ctx: ToolContext) => {
  const parsed = shellRun.parse(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return shellRun.execute(parsed.input, ctx);
};

describe("shell_run", () => {
  it("runs the command in the workspace folder and returns what happened", async () => {
    const shell = fakeShell();
    const out = await call(
      { command: "ls", cwd: "/home/kim/book/src" },
      ctxOf(shell.access),
    );
    expect(shell.calls[0]?.request).toEqual({
      workspaceId: "w1",
      path: "src",
      command: "ls",
      timeoutSeconds: 120,
    });
    expect(out.isError).toBeUndefined();
    expect(out.data).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 12,
      workspace: "Book",
      folder: "/home/kim/book/src",
      timeoutSeconds: 120,
      output: "ok\n",
    });
  });

  it("runs at the top of the workspace when cwd is its folder", async () => {
    const shell = fakeShell();
    await call({ command: "pwd", cwd: BOOK }, ctxOf(shell.access));
    expect(shell.calls[0]?.request).toMatchObject({
      workspaceId: "w1",
      path: "",
    });
  });

  it("refuses a folder that is in no workspace, without running anything", async () => {
    const shell = fakeShell();
    const out = await call(
      { command: "pwd", cwd: "/etc" },
      ctxOf(shell.access),
    );
    expect(out.isError).toBe(true);
    expect(out.details).toMatchObject({ reason: "not_found", cwd: "/etc" });
    expect(shell.calls).toHaveLength(0);
  });

  it("gives a failing command as a normal result", async () => {
    const shell = fakeShell({ ...done, exitCode: 2, output: "1 failed\n" });
    const out = await call(
      { command: "pnpm test", cwd: BOOK },
      ctxOf(shell.access),
    );
    expect(out.isError).toBeUndefined();
    expect(out.data).toMatchObject({ exitCode: 2, output: "1 failed\n" });
  });

  it("gives a command that ran out of time as a normal result", async () => {
    const shell = fakeShell({
      ...done,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    });
    const out = await call(
      { command: "sleep 999", cwd: BOOK },
      ctxOf(shell.access),
    );
    expect(out.isError).toBeUndefined();
    expect(out.data).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    });
  });

  it("puts a note where the middle of long output was cut", async () => {
    const shell = fakeShell({
      ...done,
      output: "startend",
      cutChars: 12345,
      cutAt: 5,
    });
    const out = await call({ command: "make", cwd: BOOK }, ctxOf(shell.access));
    expect(out.data).toMatchObject({
      output: "start\n[… 12,345 characters cut from the middle …]\nend",
      cutChars: 12345,
    });
  });

  describe("outputText", () => {
    it("is the output as it is when nothing was cut", () => {
      expect(outputText({ ...done, output: "abc" })).toBe("abc");
    });
    it("cuts only at the place the runner says", () => {
      const text = outputText({
        ...done,
        output: "headtail",
        cutChars: 3,
        cutAt: 4,
      });
      expect(text.startsWith("head\n[")).toBe(true);
      expect(text.endsWith("]\ntail")).toBe(true);
    });
  });

  describe("time limit", () => {
    it("uses the shorter of what was asked and the longest allowed", async () => {
      const shell = fakeShell();
      const out = await call(
        { command: "make", cwd: BOOK, timeout_seconds: 300 },
        ctxOf(shell.access),
      );
      expect(shell.calls[0]?.request.timeoutSeconds).toBe(300);
      expect(out.data).toMatchObject({ timeoutSeconds: 300 });
      expect(out.data).not.toHaveProperty("notice");
    });

    it("lowers a longer limit to the longest allowed and says so", async () => {
      const shell = fakeShell();
      const out = await call(
        { command: "make", cwd: BOOK, timeout_seconds: 900 },
        ctxOf(shell.access),
      );
      expect(shell.calls[0]?.request.timeoutSeconds).toBe(600);
      expect(out.isError).toBeUndefined();
      expect(out.data).toMatchObject({
        timeoutSeconds: 600,
        notice:
          "timeout_seconds was 900; the longest allowed is 600, so that was used.",
      });
    });

    it("uses the default when the call gives none", async () => {
      const shell = fakeShell(done, {
        defaultTimeoutSeconds: 45,
        maxTimeoutSeconds: 60,
      });
      await call({ command: "make", cwd: BOOK }, ctxOf(shell.access));
      expect(shell.calls[0]?.request.timeoutSeconds).toBe(45);
    });
  });

  describe("where it may run", () => {
    it("refuses a read-only workspace without running anything", async () => {
      const shell = fakeShell(done, undefined, [archive]);
      const out = await call(
        { command: "ls", cwd: archive.path },
        ctxOf(shell.access),
      );
      expect(out.isError).toBe(true);
      expect(out.data).toEqual({
        error:
          "The workspace Archive is read-only, so commands cannot run in it.",
      });
      expect(shell.calls).toHaveLength(0);
    });

    it("says so when the session has no shell access", async () => {
      const out = await call({ command: "ls", cwd: BOOK }, ctxOf(undefined));
      expect(out.isError).toBe(true);
    });
  });

  describe("errors from the runner", () => {
    it("turns a refused folder into an error result", async () => {
      const shell = fakeShell(
        new WorkspaceError("outside", "That path leaves the workspace."),
      );
      const out = await call({ command: "ls", cwd: BOOK }, ctxOf(shell.access));
      expect(out.isError).toBe(true);
      expect(out.data).toEqual({ error: "That path leaves the workspace." });
      expect(out.details).toMatchObject({ reason: "rejected" });
    });

    it("turns a missing folder into a not-found error", async () => {
      const shell = fakeShell(
        new WorkspaceError("not_found", "No such folder."),
      );
      const out = await call({ command: "ls", cwd: BOOK }, ctxOf(shell.access));
      expect(out.details).toMatchObject({ reason: "not_found" });
    });

    it("turns a shell that cannot start into an error result", async () => {
      const shell = fakeShell(new ShellError("Could not start /bin/zsh."));
      const out = await call({ command: "ls", cwd: BOOK }, ctxOf(shell.access));
      expect(out.isError).toBe(true);
      expect(out.data).toEqual({ error: "Could not start /bin/zsh." });
    });

    it("does not hide an unexpected failure", async () => {
      const shell = fakeShell(new Error("boom"));
      await expect(
        call({ command: "ls", cwd: BOOK }, ctxOf(shell.access)),
      ).rejects.toThrow("boom");
    });
  });

  it("gives the run's signal to the runner and passes live output on", async () => {
    const controller = new AbortController();
    const updates: string[] = [];
    const shell = fakeShell();
    await call(
      { command: "make", cwd: BOOK },
      ctxOf(shell.access, updates, controller.signal),
    );
    shell.emit("more");
    expect(shell.calls[0]?.signal).toBe(controller.signal);
    expect(updates).toEqual(["live ", "more"]);
  });

  describe("approval", () => {
    const ctx = () => ctxOf(fakeShell(done, undefined, [book, archive]).access);

    it("names the workspace the command runs in", () => {
      expect(
        shellRun.approvalSubject?.(
          { command: "ls", cwd: "/home/kim/book/src" },
          ctx(),
        ),
      ).toEqual({ kind: "workspace", id: "w1", label: "Book" });
    });

    it("names none when the folder is in no workspace or there is no shell", () => {
      expect(
        shellRun.approvalSubject?.({ command: "ls", cwd: "/etc" }, ctx()),
      ).toBeUndefined();
      expect(
        shellRun.approvalSubject?.(
          { command: "ls", cwd: BOOK },
          ctxOf(undefined),
        ),
      ).toBeUndefined();
    });
  });

  describe("input", () => {
    const parse = (input: object) => shellRun.parse({ cwd: BOOK, ...input }).ok;

    it("accepts the whole input", () => {
      expect(
        parse({
          command: "ls",
          cwd: BOOK,
          timeout_seconds: 30,
          description: "List the files",
        }),
      ).toBe(true);
    });

    it("needs a folder", () => {
      expect(shellRun.parse({ command: "ls" }).ok).toBe(false);
      expect(parse({ command: "ls", cwd: "" })).toBe(false);
    });

    it("refuses an empty or too long command", () => {
      expect(parse({ command: "" })).toBe(false);
      expect(parse({ command: "x".repeat(10_000) })).toBe(true);
      expect(parse({ command: "x".repeat(10_001) })).toBe(false);
    });

    it("keeps the time limit between 1 second and an hour", () => {
      expect(parse({ command: "ls", timeout_seconds: 0 })).toBe(false);
      expect(parse({ command: "ls", timeout_seconds: 1 })).toBe(true);
      expect(parse({ command: "ls", timeout_seconds: 3600 })).toBe(true);
      expect(parse({ command: "ls", timeout_seconds: 3601 })).toBe(false);
      expect(parse({ command: "ls", timeout_seconds: 1.5 })).toBe(false);
    });

    it("keeps the description short", () => {
      expect(parse({ command: "ls", description: "x".repeat(300) })).toBe(true);
      expect(parse({ command: "ls", description: "x".repeat(301) })).toBe(
        false,
      );
    });
  });
});
