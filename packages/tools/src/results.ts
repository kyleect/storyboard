import { FileError, type ToolOutput } from "@harness/core";

/*
 * Results shared by the projects, agents and copy tools. The errors console
 * (error reporting plan, P3) gets a reason with each error result.
 */

/** "not_found": nothing matches. "rejected": the arguments or a rule refused it. */
export type Reason = "not_found" | "rejected";

/** What a call was about, for error details. */
export type Target = Record<string, string | undefined>;

export const fail = (
  error: string,
  reason: Reason,
  target: Target = {},
): ToolOutput => ({
  data: { error },
  isError: true,
  details: {
    reason,
    ...Object.fromEntries(
      Object.entries(target).filter(([, v]) => v !== undefined),
    ),
  },
});

/**
 * The result when the user skips a form. An error result, so the model sees
 * nothing was done; the loop does not report it as an error.
 */
export const notDone = (text: string): ToolOutput => ({
  data: text,
  isError: true,
});

/** A `FileError` (a bad key, no project scope) becomes an error result. */
export async function guarded(
  target: Target,
  run: () => Promise<ToolOutput>,
): Promise<ToolOutput> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FileError) return fail(err.message, "rejected", target);
    throw err;
  }
}
