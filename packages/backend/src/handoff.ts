import {
  RunControl,
  ToolDefinition,
  type ChatRequest,
  type ControlResult,
  type Message,
  type ModelAdapter,
  type Usage,
} from "@harness/core";
import type { RunRow } from "./store.js";

/*
 * The handoff note (session rollover design): when a session is continued in
 * a new one, the session's own model writes a note about everything before
 * the messages that are copied. This is a side call, like the auto-rename
 * title: it writes no run, stores no events and cannot be stopped from the
 * chat. It fails softly: the caller gets a result, never an exception.
 */

export interface HandoffInput {
  /** The instruction (setting rolloverHandoffPrompt), sent as the last user message. */
  prompt: string;
  /** The line before the copied messages, as messages. */
  messages: readonly Message[];
  /** From the newest top-level run that recorded them; both optional. */
  system?: string;
  tools?: readonly ToolDefinition[];
  model: string | null;
  reasoningEffort: string | null;
  /** Milliseconds after the first reasoning chunk before stop-thinking is sent. */
  thinkMs: number;
  /** Milliseconds after which the whole call is abandoned. */
  totalMs: number;
  maxTokens: number;
}

export type HandoffResult =
  | { ok: true; note: string; usage: Usage | null }
  | {
      ok: false;
      reason: string;
      usage: Usage | null;
      /** Set when stop-thinking was sent: what it answered. */
      stopThinking: ControlResult | null;
    };

/**
 * Asks the model for the handoff note. The request carries the same system
 * message and tool definitions as the session's earlier requests, so the
 * server can reuse what it has cached; a tool call in the answer is never
 * run and makes the note fail. Three limits apply: the think timer sends
 * stop-thinking, the total timer aborts the call (it is the only limit that
 * ends a call where reasoning never starts or stop-thinking is refused), and
 * `maxTokens` bounds the length. A note that was cut off is not used.
 */
export async function requestHandoff(
  model: ModelAdapter,
  input: HandoffInput,
  signal: AbortSignal,
): Promise<HandoffResult> {
  const control = new RunControl();
  const request: ChatRequest = {
    kind: "chat",
    messages: [
      ...(input.system !== undefined
        ? [{ role: "system" as const, content: input.system }]
        : []),
      ...input.messages,
      { role: "user", content: input.prompt },
    ],
    ...(input.tools && input.tools.length > 0
      ? { tools: [...input.tools] }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    control,
    sampling: { maxTokens: input.maxTokens },
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const totalTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.totalMs);
  let thinkTimer: ReturnType<typeof setTimeout> | undefined;
  let thinkStarted = false;
  let stopThinking: ControlResult | null = null;

  let text = "";
  let usage: Usage | null = null;
  let finish: "stop" | "length" | "tool_calls" | undefined;
  let sawToolCall = false;
  let thrown: unknown;

  try {
    for await (const chunk of model.stream(request, controller.signal)) {
      if (chunk.type === "text") {
        text += chunk.text;
      } else if (chunk.type === "reasoning") {
        // The timer starts once, at the first reasoning chunk.
        if (!thinkStarted) {
          thinkStarted = true;
          thinkTimer = setTimeout(() => {
            control.endReasoning().then(
              (result) => {
                stopThinking = result;
              },
              (error: unknown) => {
                stopThinking = {
                  ok: false,
                  message:
                    error instanceof Error ? error.message : String(error),
                };
              },
            );
          }, input.thinkMs);
        }
      } else if (chunk.type === "tool_call") {
        // The tool is never run: the note is a text answer.
        sawToolCall = true;
        controller.abort();
        break;
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
      } else if (chunk.type === "finish") {
        finish = chunk.reason;
      }
    }
  } catch (error) {
    thrown = error;
  } finally {
    clearTimeout(totalTimer);
    if (thinkTimer !== undefined) clearTimeout(thinkTimer);
    signal.removeEventListener("abort", onAbort);
  }

  const failed = (reason: string): HandoffResult => ({
    ok: false,
    reason,
    usage,
    stopThinking,
  });
  // Our own abort for a tool call can surface as a thrown error, so the
  // reasons are decided before the error is looked at.
  if (sawToolCall || finish === "tool_calls") {
    return failed("the model called a tool");
  }
  if (timedOut) return failed("timed out");
  if (signal.aborted) return failed("stopped");
  if (thrown !== undefined) {
    return failed(thrown instanceof Error ? thrown.message : String(thrown));
  }
  if (finish === "length") {
    return failed("the note was cut off at the token limit");
  }
  const note = text.trim();
  if (note === "") return failed("the model returned no text");
  return { ok: true, note, usage };
}

/**
 * The system message and tool definitions a run recorded. A field is left out
 * when the run recorded none, or when the stored tool list cannot be read.
 */
export function recordedRequest(run: RunRow | undefined): {
  system?: string;
  tools?: ToolDefinition[];
} {
  if (!run) return {};
  const result: { system?: string; tools?: ToolDefinition[] } = {};
  if (run.system_prompt !== null) result.system = run.system_prompt;
  if (run.tools !== null) {
    try {
      const parsed = ToolDefinition.array().safeParse(JSON.parse(run.tools));
      if (parsed.success && parsed.data.length > 0) result.tools = parsed.data;
    } catch {
      // Unreadable: send no tools.
    }
  }
  return result;
}

/**
 * The newest top-level run (no parent) of the list that recorded a system
 * prompt or tools. Subagent runs are skipped: their prompt is not the
 * session's. The list is oldest first, as `Store.listRuns` returns it.
 */
export function lastRecordedRun(runs: readonly RunRow[]): RunRow | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (
      run &&
      run.parent_run_id === null &&
      (run.system_prompt !== null || run.tools !== null)
    ) {
      return run;
    }
  }
  return undefined;
}
