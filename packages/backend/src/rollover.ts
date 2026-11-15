import {
  latestToolStates,
  replaySessionData,
  replaySessionFiles,
  type CarriedMessage,
  type DataOp,
  type FileOp,
  type Message,
} from "@harness/core";
import { completePoints } from "./branches.js";
import { activeProfile } from "./profiles.js";
import type { Generation, Store, StoredMessage } from "./store.js";

/*
 * Rolling a session over (session rollover design): when a session's context
 * is full, its work goes on in a new session that holds the most recent
 * messages and the current state of its files, schemas and data. The old
 * session stays as it was, read only, and is searched through the tools.
 */

/**
 * Characters per token, for sizing messages. The harness has no tokenizer;
 * what it needs is a budget, not an exact count.
 */
const CHARS_PER_TOKEN = 4;

/** About how many tokens a message takes in a model's context. */
export function estimateTokens(message: Message): number {
  let chars = 0;
  switch (message.role) {
    case "user":
    case "tool":
    case "edit":
    case "carried":
    case "system":
      chars = message.content.length;
      break;
    case "assistant":
      for (const b of message.content) {
        if (b.type === "text" || b.type === "reasoning") chars += b.text.length;
        else chars += b.name.length + JSON.stringify(b.arguments ?? "").length;
      }
      break;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Which messages of the line the new session starts with: the index of the
 * first and of the last (session rollover design, D4). The copy ends at the
 * newest complete point, so a tool call is never left without its results,
 * and starts at a user message or at the start of a step, never at a tool
 * result. It is the longest such run of messages that fits `budgetTokens`;
 * with no budget (the context size is not known), or when even the latest
 * step does not fit, it is the latest step alone. Null: nothing to carry.
 */
export function chooseCarry(
  line: readonly StoredMessage[],
  budgetTokens: number | undefined,
): { start: number; end: number } | null {
  const points = completePoints(line);
  let end = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    const m = line[i];
    if (m && points.has(m.id)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  // A message the copy may start at.
  const starts: number[] = [];
  for (let i = 0; i <= end; i++) {
    const m = line[i]?.message;
    if (!m || m.role === "carried") continue;
    const previous = line[i - 1];
    // An assistant message that answers a user message belongs to it; one
    // that follows tool results or another reply starts a step of its own.
    const startsStep =
      m.role === "assistant" &&
      (previous === undefined ||
        ((previous.message.role === "tool" ||
          previous.message.role === "assistant") &&
          points.has(previous.id)));
    if (m.role === "user" || m.role === "edit" || startsStep) starts.push(i);
  }
  const last = starts.at(-1);
  if (last === undefined) return null;
  // The latest step is always carried.
  let start = last;
  if (budgetTokens === undefined) return { start, end };
  const tokens = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i <= to; i++) {
      const m = line[i]?.message;
      if (m && m.role !== "carried") n += estimateTokens(m);
    }
    return n;
  };
  let used = tokens(last, end);
  // Then earlier steps, newest first, while they still fit.
  for (let k = starts.length - 2; k >= 0; k--) {
    const from = starts[k] as number;
    const next = starts[k + 1] as number;
    const size = tokens(from, next - 1);
    if (used + size > budgetTokens) break;
    used += size;
    start = from;
  }
  return { start, end };
}

/** The title of the session that continues one: "Title (2)", "Title (3)". */
export function continuedTitle(title: string): string {
  const match = /^(.*) \((\d+)\)$/.exec(title);
  return match ? `${match[1]} (${Number(match[2]) + 1})` : `${title} (2)`;
}

/** The notice the model reads with the carried state. */
export function carriedNotice(title: string): string {
  const named = title.trim() === "" ? "an earlier session" : `"${title}"`;
  return `[This session continues ${named}, which ran out of room in its context. Only its most recent messages follow. The session's files, schemas and data are carried over as they stood.]`;
}

/**
 * The state the new session starts with, read from the whole old line: every
 * session file and folder as it is now, every version of each schema (data
 * may pin an older one) and each piece of data, and each tool's latest saved
 * state. What was deleted is left out (D6, current state only).
 */
export function buildCarried(
  line: readonly Message[],
  title: string,
): CarriedMessage {
  const files = replaySessionFiles(line);
  const fileOps: FileOp[] = [
    ...[...files.folders]
      .sort()
      .map((path): FileOp => ({ op: "folder", action: "create", path })),
    ...[...files.files].map(([key, f]): FileOp => ({
      op: "put",
      key,
      value: f.value,
      ...(f.mediaType ? { mediaType: f.mediaType } : {}),
      ...(f.blob ? { blob: f.blob } : {}),
    })),
  ];
  const state = replaySessionData(line);
  const dataOps: DataOp[] = [];
  const live = new Set<string>();
  for (const s of state.schemas.values()) {
    if (s.deleted) continue;
    live.add(s.id);
    // Ascending, so the last put is the latest version.
    for (const version of [...s.versions.keys()].sort((a, b) => a - b)) {
      dataOps.push({
        op: "schema_put",
        id: s.id,
        name: s.name,
        description: s.description,
        version,
        body: s.versions.get(version),
        ...(s.copiedFrom ? { copiedFrom: s.copiedFrom } : {}),
      });
    }
  }
  for (const d of state.data.values()) {
    if (d.deleted || !live.has(d.schemaId)) continue;
    dataOps.push({
      op: "data_put",
      id: d.id,
      schemaId: d.schemaId,
      schemaVersion: d.schemaVersion,
      name: d.name,
      description: d.description,
      value: d.value,
    });
  }
  const toolState = latestToolStates(line);
  return {
    role: "carried",
    content: carriedNotice(title),
    files: fileOps,
    ...(dataOps.length > 0 ? { dataOps } : {}),
    ...(Object.keys(toolState).length > 0 ? { toolState } : {}),
  };
}

export interface RolloverInput {
  sourceId: string;
  newSessionId: string;
  now: string;
  newId: () => string;
  /** The context size of the session's model; undefined: not known. */
  contextSize: number | undefined;
  /** The share of the context size the copied messages may take, in percent. */
  carryPercent: number;
}

export interface RolloverResult {
  /** The messages copied, not counting the carried state. */
  carried: number;
}

const generationOf = (m: StoredMessage): Generation => ({
  model: m.model,
  reasoningEffort: m.reasoningEffort,
  agent: m.agent ? { id: m.agent.id, version: m.agent.version } : null,
});

/**
 * Makes the new session: its first message holds the carried state, then the
 * chosen recent messages follow, and what the user decided for the old
 * session (tool approvals, media choices) comes along. Run it inside a
 * transaction. The caller has checked the source is idle, not continued and
 * not in the trash; workspaces and the search index are the caller's.
 */
export function rolloverSession(
  store: Store,
  input: RolloverInput,
): RolloverResult {
  const { db } = store;
  const { sourceId, newSessionId, now, newId } = input;
  const source = store.getSession(sourceId);
  if (!source) throw new Error("Session not found.");
  const line = store.listMessages(sourceId, "top");
  const budget =
    input.contextSize === undefined
      ? undefined
      : Math.floor((input.contextSize * input.carryPercent) / 100);
  const range = chooseCarry(line, budget);
  if (!range) throw new Error("There is nothing to carry over.");
  const copied = line
    .slice(range.start, range.end + 1)
    .filter((m) => m.message.role !== "carried");

  const title = continuedTitle(source.title);
  db.prepare(
    `INSERT INTO sessions
       (id, profile_id, title, created_at, project_id, model, reasoning_effort, agent_id,
        continued_from_id, continued_from_title, continued_carried)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    activeProfile(db),
    title,
    now,
    source.project_id,
    source.model,
    source.reasoning_effort,
    source.agent_id,
    source.id,
    source.title,
    copied.length,
  );

  store.addMessage(
    newSessionId,
    newId(),
    buildCarried(
      line.map((m) => m.message),
      source.title,
    ),
    now,
  );
  // The copies keep their times, models and agents. Their usage is not
  // copied: it measured the old context, and the new session's meter starts
  // from its own first call (D3).
  const times = store.messageTimes(sourceId);
  for (const m of copied) {
    store.addMessage(
      newSessionId,
      newId(),
      m.message,
      times.get(m.id) ?? now,
      generationOf(m),
    );
  }

  // What the user chose for this session.
  db.prepare(
    `INSERT INTO media_choices (session_id, ref, keep, updated_at)
     SELECT ?, ref, keep, updated_at FROM media_choices WHERE session_id = ?`,
  ).run(newSessionId, sourceId);
  db.prepare(
    `INSERT INTO session_tool_approvals (session_id, tool_name, created_at)
     SELECT ?, tool_name, created_at FROM session_tool_approvals WHERE session_id = ?`,
  ).run(newSessionId, sourceId);
  db.prepare(
    `INSERT INTO session_subject_approvals
       (session_id, tool_name, subject_kind, subject_id, created_at)
     SELECT ?, tool_name, subject_kind, subject_id, created_at
     FROM session_subject_approvals WHERE session_id = ?`,
  ).run(newSessionId, sourceId);

  return { carried: copied.length };
}
