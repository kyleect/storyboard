import type { StoredEvent, ToolDefinition } from "@harness/core";
import type { SessionRow, Store, StoredBranchMessage } from "./store.js";

/*
 * A session exported for debugging: everything needed to see what the model
 * was sent and what came back. The composed system prompt and the tool
 * definitions are kept per run (a subagent's run has its own); the transcript
 * and the event log are the session's.
 */

export interface DebugRun {
  id: string;
  parentRunId: string | null;
  parentCallId: string | null;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agent: { id: string; version: number } | null;
  usage: unknown;
  error: string | null;
  /**
   * The system message as sent. Null when the run had none, or when it was
   * made before prompts were recorded; `request` says which.
   */
  systemPrompt: string | null;
  /** The tools the run offered. Null when not recorded. */
  tools: ToolDefinition[] | null;
  /** `recorded`: the prompt and tools were kept; `not_recorded`: they were not. */
  request: "recorded" | "not_recorded";
}

/**
 * A stored message with when it was created (user messages have no event),
 * and where it sits in the tree: `parentId`, whether it is on the line the
 * session shows (`active`), and whether it is in a deleted branch.
 */
export type DebugMessage = StoredBranchMessage & { createdAt: string | null };

export interface SessionDebug {
  /** Version of this shape, so a pasted export can be told apart later. */
  format: 2;
  exportedAt: string;
  session: SessionRow;
  project: unknown;
  runs: DebugRun[];
  /**
   * The transcript: every message of the session, every branch and the
   * subagents' included. Version 2 added `parentId`, `active` and `trashed`.
   */
  messages: DebugMessage[];
  /** Every stored event of the session, in order. */
  events: StoredEvent[];
}

const parseJson = <T>(json: string | null): T | null =>
  json === null ? null : (JSON.parse(json) as T);

export function buildSessionDebug(
  store: Store,
  session: SessionRow,
  now: string,
): SessionDebug {
  const runs: DebugRun[] = store.listRuns(session.id).map((r) => {
    // A run made after the migration always stores its tools (an empty list
    // at least), so a NULL there means the request was not recorded.
    const recorded = r.tools !== null;
    return {
      id: r.id,
      parentRunId: r.parent_run_id,
      parentCallId: r.parent_call_id,
      kind: r.kind,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      model: r.model,
      reasoningEffort: r.reasoning_effort,
      agent:
        r.agent_id !== null && r.agent_version !== null
          ? { id: r.agent_id, version: r.agent_version }
          : null,
      usage: parseJson(r.usage),
      error: r.error,
      systemPrompt: r.system_prompt,
      tools: parseJson<ToolDefinition[]>(r.tools),
      request: recorded ? "recorded" : "not_recorded",
    };
  });
  const times = store.messageTimes(session.id);
  return {
    format: 2,
    exportedAt: now,
    session,
    project: session.project_id
      ? (store.getProject(session.project_id) ?? null)
      : null,
    runs,
    messages: store
      .listMessages(session.id, "all")
      .map((m) => ({ ...m, createdAt: times.get(m.id) ?? null })),
    events: store.eventsAfter(session.id, 0),
  };
}
