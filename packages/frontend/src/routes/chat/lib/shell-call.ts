/*
 * What the chat shows of a `shell_run` call: the command as the model wrote it
 * and, once it ended, the result. The shapes are those of the tool in
 * `packages/tools/src/shell.ts`; anything that does not fit is treated as not
 * a shell call, so the generic display is used instead.
 */

export const SHELL_RUN = "shell_run";

export interface ShellCall {
  command: string;
  cwd: string;
  timeoutSeconds: number | undefined;
  description: string | undefined;
}

export interface ShellOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  workspace: string;
  folder: string;
  timeoutSeconds: number | undefined;
  output: string;
  notice: string | undefined;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The arguments of a call, which arrive as an object or as JSON text. */
const argumentsOf = (args: unknown): Record<string, unknown> | undefined => {
  if (typeof args !== "string") return record(args);

  try {
    return record(JSON.parse(args));
  } catch {
    return undefined;
  }
};

export function readShellCall(args: unknown): ShellCall | undefined {
  const a = argumentsOf(args);

  if (!a || typeof a["command"] !== "string") return undefined;

  return {
    command: a["command"],
    cwd: typeof a["cwd"] === "string" ? a["cwd"] : "",
    timeoutSeconds:
      typeof a["timeout_seconds"] === "number"
        ? a["timeout_seconds"]
        : undefined,
    description:
      typeof a["description"] === "string" && a["description"].trim() !== ""
        ? a["description"]
        : undefined,
  };
}

export function readShellOutcome(data: unknown): ShellOutcome | undefined {
  const d = record(data);

  if (
    !d ||
    typeof d["output"] !== "string" ||
    typeof d["timedOut"] !== "boolean" ||
    typeof d["durationMs"] !== "number"
  ) {
    return undefined;
  }

  return {
    exitCode: typeof d["exitCode"] === "number" ? d["exitCode"] : null,
    signal: typeof d["signal"] === "string" ? d["signal"] : null,
    timedOut: d["timedOut"],
    durationMs: d["durationMs"],
    workspace: typeof d["workspace"] === "string" ? d["workspace"] : "",
    folder: typeof d["folder"] === "string" ? d["folder"] : "",
    timeoutSeconds:
      typeof d["timeoutSeconds"] === "number" ? d["timeoutSeconds"] : undefined,
    output: d["output"],
    notice: typeof d["notice"] === "string" ? d["notice"] : undefined,
  };
}

/** One line on how the command ended. */
export function outcomeText(o: ShellOutcome): string {
  const took =
    o.durationMs < 1000
      ? `${o.durationMs} ms`
      : `${(o.durationMs / 1000).toFixed(1)} s`;

  if (o.timedOut) {
    return `Ended at the time limit${
      o.timeoutSeconds !== undefined ? ` of ${o.timeoutSeconds} s` : ""
    } after ${took}`;
  }

  if (o.exitCode === null) {
    return `Ended by ${o.signal ?? "a signal"} after ${took}`;
  }

  return `Exit code ${o.exitCode} after ${took}`;
}
