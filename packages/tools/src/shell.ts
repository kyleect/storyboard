import { z } from "zod";
import {
  defineTool,
  SHELL_COMMAND_MAX_CHARS,
  SHELL_DESCRIPTION_MAX_CHARS,
  SHELL_TIMEOUT_LIMIT_SECONDS,
  ShellError,
  WorkspaceError,
  type ApprovalSubject,
  type ShellResult,
  type ToolContext,
} from "@harness/core";
import { fail } from "./results.js";

/*
 * The shell tool: one command in a workspace folder, one process per call.
 * It always asks, so no setting or agent can switch the question off, and it
 * is marked `needsReview` so no agent gets it without being given it by name.
 * It is offered only where a writable workspace is attached and the platform
 * can run it (`shellAvailable`).
 */

const CWD_HELP =
  "The folder to run in, as a full path on the computer, such as the path of a workspace or a folder inside it. It must be inside a workspace. Call workspaces_list for the workspaces and their paths.";

/** The subject an approval names: the workspace the command runs in. */
const subjectOf = (
  input: { cwd: string },
  ctx: ToolContext,
): ApprovalSubject | undefined => {
  const found = ctx.shell?.locate(input.cwd);
  if (!found || "error" in found) return undefined;
  return {
    kind: "workspace",
    id: found.workspace.id,
    label: found.workspace.name,
  };
};

/** The note that goes where the middle of long output was cut. */
const cutNote = (chars: number) =>
  `\n[… ${chars.toLocaleString("en-US")} characters cut from the middle …]\n`;

/** The output the model reads: the kept start and end, with a note between. */
export function outputText(result: ShellResult): string {
  if (result.cutChars <= 0) return result.output;
  return (
    result.output.slice(0, result.cutAt) +
    cutNote(result.cutChars) +
    result.output.slice(result.cutAt)
  );
}

export const shellRun = defineTool({
  name: "shell_run",
  description:
    "Runs one shell command in a workspace folder and returns its output and exit code. The user sees every command and approves it before it runs. " +
    "Each call is a new process: a cd or an exported variable does not carry over to the next call, so give the folder in cwd and join dependent steps in one command (for example with &&). " +
    "Standard input is closed, so a program that waits for input fails instead of waiting. " +
    "The command is ended when its time limit passes (timeout_seconds; the default and the longest allowed are settings). " +
    "Standard output and standard error come back as one text, in the order they were written; when it is long, the middle is cut and the result says how much. " +
    "Background processes are not supported: do not start servers or watchers that keep running. " +
    "The command runs with the user's own permissions on their computer.",
  input: z.object({
    command: z
      .string()
      .min(1)
      .max(SHELL_COMMAND_MAX_CHARS)
      .describe(
        "The command, as the shell reads it. A long script belongs in a file written with the workspace tools.",
      ),
    cwd: z.string().min(1).describe(CWD_HELP),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(SHELL_TIMEOUT_LIMIT_SECONDS)
      .optional()
      .describe(
        "How long the command may run, in seconds. Left out: the default. Above the longest allowed, the longest allowed is used and the result says so.",
      ),
    description: z
      .string()
      .max(SHELL_DESCRIPTION_MAX_CHARS)
      .optional()
      .describe(
        "A short note on what the command is for. The user sees it next to the command.",
      ),
  }),
  approval: "always",
  group: "shell",
  needsReview: true,
  available: (run) => run.shellAvailable === true,
  approvalSubject: subjectOf,
  execute: async (input, ctx) => {
    const cwd = input.cwd;
    const target = { cwd };
    const shell = ctx.shell;
    if (!shell) {
      return fail(
        "Running commands is not available in this session.",
        "rejected",
        target,
      );
    }
    const found = shell.locate(cwd);
    if ("error" in found) return fail(found.error, "not_found", target);
    if (!found.workspace.writable) {
      return fail(
        `The workspace ${found.workspace.name} is read-only, so commands cannot run in it.`,
        "rejected",
        target,
      );
    }

    const asked = input.timeout_seconds ?? shell.defaultTimeoutSeconds;
    const timeoutSeconds = Math.min(asked, shell.maxTimeoutSeconds);
    const notice =
      asked > timeoutSeconds
        ? `timeout_seconds was ${asked}; the longest allowed is ${shell.maxTimeoutSeconds}, so that was used.`
        : undefined;

    let result: ShellResult;
    try {
      result = await shell.run(
        {
          workspaceId: found.workspace.id,
          path: found.path,
          command: input.command,
          timeoutSeconds,
        },
        { signal: ctx.signal, onOutput: ctx.update },
      );
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return fail(
          err.message,
          err.code === "not_found" ? "not_found" : "rejected",
          target,
        );
      }
      if (err instanceof ShellError) {
        return fail(err.message, "rejected", target);
      }
      throw err;
    }

    // A command that fails, or runs out of time, is a result: the model reads
    // the output and decides what to do (a failing test is not a tool error).
    return {
      data: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        workspace: found.workspace.name,
        folder: found.cwd,
        timeoutSeconds,
        output: outputText(result),
        ...(result.cutChars > 0 ? { cutChars: result.cutChars } : {}),
        ...(notice ? { notice } : {}),
      },
    };
  },
});

export const shellTools = [shellRun];
