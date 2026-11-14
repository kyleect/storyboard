import type { ContentBlock, StoredEvent } from "@harness/core";
import type { DebugMessage, DebugRun, SessionDebug } from "../../../api";
import { eventSummary, shortId } from "./debug";

export type LinearKind =
  "system" | "tools" | "user" | "assistant" | "tool" | "edit" | "event";

export const LINEAR_KINDS: readonly LinearKind[] = [
  "system",
  "tools",
  "user",
  "assistant",
  "tool",
  "edit",
  "event",
];

export interface LinearItem {
  key: string;
  kind: LinearKind;
  title: string;
  time: string | null;
  runId: string | null;
  depth: number;
  text?: string;
  blocks?: ContentBlock[];
  meta?: string;
  calls?: Record<string, string>;
  extras?: Record<string, unknown>;
  raw: unknown;
  isError?: boolean;
}

const REPEATS: ReadonlySet<string> = new Set([
  "step.started",
  "step.finished",
  "message.started",
  "text.delta",
  "text.end",
  "reasoning.delta",
  "reasoning.end",
  "tool.called",
  "tool.update",
]);

const ANCHORS: ReadonlySet<string> = new Set([
  "message.finished",
  "tool.result",
  "user.message",
  "session.files_changed",
  "session.data_changed",
  "session.transcript_changed",
]);

const messageIdOf = (e: StoredEvent): string | undefined => {
  if (!ANCHORS.has(e.type)) return undefined;

  const id = (e.data as { messageId?: unknown }).messageId;

  return typeof id === "string" ? id : undefined;
};

function requestItems(run: DebugRun, depth: number, key: string, time: string) {
  const base = { time, runId: run.id, depth };

  if (run.request === "not_recorded") {
    return [
      {
        ...base,
        key: `${key}-system`,
        kind: "system" as const,
        title: "System prompt",
        text: "Not recorded: this run was made before system prompts were kept.",
        raw: null,
      },
    ];
  }

  const tools = run.tools ?? [];

  return [
    {
      ...base,
      key: `${key}-system`,
      kind: "system" as const,
      title: "System prompt",
      text: run.systemPrompt ?? "None was sent.",
      raw: run.systemPrompt,
    },
    {
      ...base,
      key: `${key}-tools`,
      kind: "tools" as const,
      title: `Tools (${tools.length})`,
      text:
        tools.length === 0
          ? "None offered."
          : tools.map((t) => t.name).join(", "),
      raw: tools,
    },
  ];
}

function metaOf(m: DebugMessage): string | undefined {
  const parts = [
    m.model ? `model ${m.model}` : undefined,
    m.reasoningEffort ? `reasoning ${m.reasoningEffort}` : undefined,
    m.agent ? `agent ${m.agent.name} v${m.agent.version}` : undefined,
    m.usage
      ? `tokens in ${m.usage.promptTokens} / out ${m.usage.completionTokens}`
      : undefined,
  ].filter((p): p is string => p !== undefined);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const present = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function withFiles(text: string, files: readonly string[] | undefined): string {
  if (!files || files.length === 0) return text;

  const lines = files.map((ref) => `[attached: ${ref}]`);

  return text === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${text}`;
}

function messageItem(
  m: DebugMessage,
  key: string,
  runId: string | null,
  depth: number,
  time: string | null,
  extra: string,
): LinearItem {
  const base = { key, time, runId, depth, raw: m };
  const msg = m.message;

  switch (msg.role) {
    case "user":
      return {
        ...base,
        kind: "user",
        title:
          msg.source === "task"
            ? "User (task from the agent)"
            : msg.source === "reminder"
              ? "User (reminder)"
              : msg.source === "user"
                ? "User (sent to the subagent)"
                : "User",
        text: withFiles(msg.content, msg.files),
      };
    case "assistant": {
      const meta = metaOf(m);

      return {
        ...base,
        kind: "assistant",
        title: `Assistant${extra}`,
        blocks: msg.content,
        ...(meta ? { meta } : {}),
      };
    }
    case "tool": {
      const dataText =
        typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
      const extras = present({
        decisionComment: msg.decisionComment,
        prompt: msg.prompt,
        files: msg.files,
        dataOps: msg.dataOps,
        state: msg.state,
        data:
          msg.data === undefined || dataText === msg.content
            ? undefined
            : msg.data,
      });

      return {
        ...base,
        kind: "tool",
        title: `Result of ${msg.name}${msg.isError ? " (error)" : ""}`,
        text: msg.content,
        isError: msg.isError,
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      };
    }
    case "edit": {
      const extras = present({ files: msg.files, dataOps: msg.dataOps });

      return {
        ...base,
        kind: "edit",
        title: "Edited by the user",
        text: msg.content,
        extras,
      };
    }
    case "system":
      return { ...base, kind: "system", title: "System", text: msg.content };
  }
}

export function buildLinear(debug: SessionDebug): LinearItem[] {
  const runs = new Map(debug.runs.map((r) => [r.id, r]));
  const depthOf = (runId: string | null): number => {
    let depth = 0;
    let run = runId === null ? undefined : runs.get(runId);

    while (run?.parentRunId) {
      depth++;
      run = runs.get(run.parentRunId);
    }

    return depth;
  };
  const byId = new Map(debug.messages.map((m) => [m.id, m]));

  const anchored = new Set<string>();

  for (const e of debug.events) {
    const id = messageIdOf(e);

    if (id !== undefined && byId.has(id)) anchored.add(id);
  }

  const unplaced = debug.messages.filter((m) => !anchored.has(m.id));
  const loose = [
    ...unplaced.filter((m) => m.createdAt !== null),
    ...unplaced.filter((m) => m.createdAt === null),
  ];
  let next = 0;

  const out: LinearItem[] = [];
  const placed = new Set<string>();
  const flushLoose = (until: string | null) => {
    while (next < loose.length) {
      const m = loose[next];

      if (!m) break;

      if (until !== null && (m.createdAt === null || m.createdAt > until))
        break;

      next++;
      placed.add(m.id);
      out.push(
        messageItem(m, `m-${m.id}`, m.runId, depthOf(m.runId), m.createdAt, ""),
      );
    }
  };

  for (const e of debug.events) {
    if (REPEATS.has(e.type)) continue;

    flushLoose(e.time);
    const runId = e.runId;
    const depth = depthOf(runId);
    const key = `e-${e.id}`;
    const id = messageIdOf(e);
    const message = id === undefined ? undefined : byId.get(id);

    if (message && id !== undefined && !placed.has(id)) {
      placed.add(id);
      const reason =
        e.type === "message.finished"
          ? ` · ${(e.data as { finishReason?: string }).finishReason ?? ""}`
          : "";

      out.push(messageItem(message, key, runId, depth, e.time, reason));
      continue;
    }

    out.push({
      key,
      kind: "event",
      title: e.type,
      time: e.time,
      runId,
      depth,
      text: eventSummary(e, Infinity),
      raw: e,
      isError: e.type === "run.failed" || e.type === "tool.malformed",
    });

    if (e.type === "run.started" && runId !== null) {
      const run = runs.get(runId);

      if (run) out.push(...requestItems(run, depth, `r-${run.id}`, e.time));
    }
  }

  flushLoose(null);

  const tag = (id: string) => {
    const i = debug.runs.findIndex((r) => r.id === id);

    return i < 0 ? shortId(id) : `${i + 1} (${shortId(id)})`;
  };
  const startedBy = new Map<string, DebugRun>();

  for (const r of debug.runs) {
    if (r.parentRunId && r.parentCallId) {
      startedBy.set(`${r.parentRunId}\u0000${r.parentCallId}`, r);
    }
  }

  for (const item of out) {
    if (item.kind === "assistant" && item.blocks && item.runId) {
      const calls: Record<string, string> = {};

      for (const b of item.blocks) {
        if (b.type !== "tool_call") continue;

        const child = startedBy.get(`${item.runId}\u0000${b.callId}`);

        if (child) calls[b.callId] = `starts run ${tag(child.id)}`;
      }

      if (Object.keys(calls).length > 0) item.calls = calls;
    }

    if (item.kind === "event" && item.title === "run.started" && item.runId) {
      const r = runs.get(item.runId);

      if (r?.parentRunId && r.parentCallId) {
        item.meta = `started by call ${r.parentCallId} in run ${tag(r.parentRunId)}`;
      }
    }
  }

  return out;
}

export interface LinearFilter {
  text: string;
  kinds: readonly LinearKind[];
  runId: string | null;
}

export const NO_LINEAR_FILTER: LinearFilter = {
  text: "",
  kinds: LINEAR_KINDS,
  runId: null,
};

export function filterLinear(
  items: readonly LinearItem[],
  filter: LinearFilter,
): LinearItem[] {
  const kinds = new Set(filter.kinds);
  const needle = filter.text.trim().toLowerCase();

  return items.filter((i) => {
    if (!kinds.has(i.kind)) return false;

    if (filter.runId !== null && i.runId !== filter.runId) return false;

    if (needle === "") return true;

    return (
      i.title.toLowerCase().includes(needle) ||
      (i.text ?? "").toLowerCase().includes(needle) ||
      JSON.stringify(i.blocks ?? i.raw ?? "")
        .toLowerCase()
        .includes(needle)
    );
  });
}

const READING_NOTES = [
  "Items are in the order they happened. Each run starts with the system prompt and tools it was given.",
  "A subagent's items are marked and sit where it ran; a top-level run's own request does not include its subagents' messages.",
  "The model is sent edit messages merged into neighbouring user messages, and the comments in a tool result's decision comment as a user message after that turn's results.",
  "Streaming deltas and tool progress updates are left out. Messages are complete, and every event is given in full as JSON.",
];

const json = (value: unknown) => JSON.stringify(value);

function bodyText(item: LinearItem): string {
  const lines: string[] = [];

  if (item.meta) lines.push(item.meta);

  if (item.kind === "tools" && Array.isArray(item.raw)) {
    for (const t of item.raw as {
      name: string;
      description: string;
      inputSchema: unknown;
    }[]) {
      lines.push(`tool ${t.name}: ${t.description}`);
      lines.push(`input schema: ${json(t.inputSchema)}`);
    }

    if (item.raw.length === 0) lines.push("None offered.");
  } else if (item.kind === "event") {
    const data = (item.raw as { data?: unknown }).data;
    const empty =
      data === undefined ||
      (typeof data === "object" &&
        data !== null &&
        Object.keys(data).length === 0);

    if (!empty) lines.push(json(data));
  } else if (item.blocks) {
    if (item.blocks.length === 0) lines.push("(empty)");

    for (const b of item.blocks) {
      if (b.type === "reasoning") lines.push("[reasoning]", b.text);
      else if (b.type === "text") lines.push("[text]", b.text);
      else {
        const starts = item.calls?.[b.callId];

        lines.push(
          `[tool call ${b.name} id=${b.callId}${starts ? ` → ${starts}` : ""}]`,
        );
        lines.push(
          typeof b.arguments === "string"
            ? b.arguments
            : JSON.stringify(b.arguments, null, 2),
        );
      }
    }
  } else if (item.text !== undefined) {
    lines.push(item.text);
  }

  if (item.extras && Object.keys(item.extras).length > 0) {
    lines.push("[details]", JSON.stringify(item.extras, null, 2));
  }

  return lines.join("\n");
}

export function renderLinearText(
  debug: SessionDebug,
  items: readonly LinearItem[] = buildLinear(debug),
): string {
  const runNumbers = new Map(
    debug.runs.map((r, i) => [r.id, `${i + 1} (${shortId(r.id)})`]),
  );
  const project = debug.project as { id?: string; name?: string } | null;
  const out: string[] = [
    "# Session debug export",
    `Session: ${debug.session.title} (${debug.session.id})`,
    `Project: ${project ? `${project.name ?? ""} (${project.id ?? ""})` : "none"}`,
    `Exported: ${debug.exportedAt}`,
    `Runs: ${debug.runs.length} · Messages: ${debug.messages.length} · Events: ${debug.events.length}`,
    "",
    ...READING_NOTES.map((n) => `- ${n}`),
    "",
  ];

  for (const item of items) {
    const where = [
      item.runId === null
        ? undefined
        : `run ${runNumbers.get(item.runId) ?? shortId(item.runId)}`,
      item.depth > 0 ? `subagent, depth ${item.depth}` : undefined,
    ].filter((p): p is string => p !== undefined);

    out.push(
      `----- [${item.time ?? "no time"}] ${item.title}${
        where.length > 0 ? ` · ${where.join(" · ")}` : ""
      } -----`,
    );

    if (item.kind === "event" && item.title === "run.started" && item.runId) {
      out.push(`run id: ${item.runId}`);
    }

    const body = bodyText(item);

    if (body !== "") out.push(body);

    out.push("");
  }

  return out.join("\n");
}
