import type { WorkspaceInfo } from "./workspaces.js";

/*
 * Running shell commands. The tool reaches the machine only through
 * `ShellAccess`, which the backend implements: it resolves the folder, starts
 * the process, keeps the time limit and cleans the output. A sandbox added
 * later sits behind the same interface.
 */

/** One command to run in a workspace folder. */
export interface ShellRequest {
  /** The workspace the command runs in. */
  workspaceId: string;
  /** The folder inside the workspace; the empty string is its root. */
  path: string;
  command: string;
  /** How long the command may run before it is ended. */
  timeoutSeconds: number;
}

/** Where a folder named by its real path is, among the workspaces. */
export interface ShellLocation {
  workspace: WorkspaceInfo;
  /** The folder inside the workspace, for `ShellRequest.path`; "" is its root. */
  path: string;
  /** The folder's full path, cleaned of `.` and `..`. */
  cwd: string;
}

/** What a command did. */
export interface ShellResult {
  /** Null when a signal ended the process. */
  exitCode: number | null;
  /** The signal that ended the process, when one did. */
  signal: string | null;
  /** True when the time limit ended the command. */
  timedOut: boolean;
  durationMs: number;
  /**
   * What the command wrote to standard output and standard error, in the
   * order it arrived, with terminal escape codes removed. Over the output
   * cap only the start and the end are kept.
   */
  output: string;
  /**
   * How many characters were cut from the middle of `output`; 0: nothing.
   * `output` has no marker; the tool adds the note at `cutAt`.
   */
  cutChars: number;
  /** Where in `output` the cut was made (the end of the start that was kept). */
  cutAt: number;
}

/** The shell could not be started (no such program, not allowed to run it). */
export class ShellError extends Error {
  override name = "ShellError";
}

/** What the backend lets a run do with the shell. */
export interface ShellAccess {
  /** The time limit when the call gives none, in seconds (a setting). */
  readonly defaultTimeoutSeconds: number;
  /** The longest time limit a call may have, in seconds (a setting). */
  readonly maxTimeoutSeconds: number;
  /**
   * Finds the workspace that holds a folder named by its full path on the
   * computer. The folder must be inside one of the session's workspaces. The
   * error says what to write instead.
   */
  locate(cwd: string): ShellLocation | { error: string };
  /**
   * Runs the command in the folder and waits for it to end. Throws a
   * `WorkspaceError` when the folder cannot be used (not found, outside the
   * workspace, read-only workspace). A command that fails is a result, not an
   * error; a shell that cannot be started throws a `ShellError`. `io.signal` ends the process when it fires; `io.onOutput` gets the
   * cleaned output as it arrives.
   */
  run(
    request: ShellRequest,
    io: { signal: AbortSignal; onOutput: (text: string) => void },
  ): Promise<ShellResult>;
}

/** The longest `timeout_seconds` a call can name; Settings cannot exceed it. */
export const SHELL_TIMEOUT_LIMIT_SECONDS = 3600;

/** The longest command the tool accepts, in characters. */
export const SHELL_COMMAND_MAX_CHARS = 10_000;

/** The longest `description` the tool accepts, in characters. */
export const SHELL_DESCRIPTION_MAX_CHARS = 300;
