import type { StoredEvent } from "@harness/core";
import type { DebugRun } from "./api";

/*
 * Helpers for the session debugging tools: copying the export to the
 * clipboard, and summarizing and filtering the event log.
 */

/**
 * Copies text to the clipboard. `text` may be a promise, so the copy can
 * start inside the click while the text is still being fetched: Safari's
 * WebView (the Tauri shell on macOS) only allows a clipboard write made
 * during the gesture, and a write made after an `await` is refused. When
 * the promise rejects, the rejection is thrown.
 */
export async function copyText(text: string | Promise<string>): Promise<void> {
  const pending = Promise.resolve(text);
  // Avoid an unhandled rejection if only one of the paths below awaits it.
  pending.catch(() => {});

  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": pending.then(
            (t) => new Blob([t], { type: "text/plain" }),
          ),
        }),
      ]);
      return;
    } catch {
      // Fall through; a rejected `pending` is thrown by the next await.
    }
  }

  const value = await pending;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }

  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("The browser refused to copy.");
    }
  } finally {
    area.remove();
  }
}

/** Events that arrive in large numbers while a message streams. */
export const STREAMING_TYPES: ReadonlySet<string> = new Set([
  "text.delta",
  "reasoning.delta",
  "tool.update",
]);

const clip = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** A one-line description of an event for the table. */
export function eventSummary(event: StoredEvent, max = 80): string {
  const show = (value: unknown) =>
    clip(
      typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
      max,
    );
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case "run.started": {
      const agent = d["agent"] as { name?: string } | undefined;
      return [
        d["kind"],
        agent?.name ? `agent ${agent.name}` : undefined,
        d["model"],
        d["parentRunId"] ? "subagent" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "step.started":
    case "step.finished":
      return `step ${String(d["index"])}`;
    case "message.started":
      return String(d["messageId"]);
    case "text.delta":
    case "reasoning.delta":
    case "text.end":
    case "reasoning.end":
      return show(d["text"]);
    case "message.finished":
      return `${String(d["finishReason"])}`;
    case "tool.called":
      return `${String(d["name"])} ${show(d["arguments"])}`;
    case "tool.malformed":
      return `${String(d["name"])}: ${show(d["error"])}`;
    case "tool.result":
      return `${String(d["name"])}${d["isError"] ? " (error)" : ""} · ${String(
        d["durationMs"],
      )} ms · ${show(d["preview"])}`;
    case "tool.update":
      return show(d["partial"]);
    case "tool.approval_requested":
      return `${String(d["name"])} ${show(d["arguments"])}`;
    case "tool.approval_resolved":
      return String(d["choice"]);
    case "input.requested":
    case "input.resolved":
    case "request.cancel":
      return show(d["outcome"] ?? d["reason"] ?? d["requestId"]);
    case "run.finished":
      return String(d["reason"]);
    case "run.failed":
      return show(d["error"]);
    case "session.renamed":
      return show(d["title"]);
    default:
      return "";
  }
}

export interface EventFilter {
  /** Matches the type, the summary, the run id and the data. */
  text: string;
  /** Event types to show; empty: all. */
  types: readonly string[];
  /** A run id to show; null: all runs. */
  runId: string | null;
  hideStreaming: boolean;
}

export const NO_FILTER: EventFilter = {
  text: "",
  types: [],
  runId: null,
  hideStreaming: true,
};

/** The events that pass every part of the filter, in their order. */
export function filterEvents(
  events: readonly StoredEvent[],
  filter: EventFilter,
): StoredEvent[] {
  const needle = filter.text.trim().toLowerCase();
  const types = new Set(filter.types);
  return events.filter((e) => {
    if (filter.hideStreaming && STREAMING_TYPES.has(e.type)) return false;
    if (types.size > 0 && !types.has(e.type)) return false;
    if (filter.runId !== null && e.runId !== filter.runId) return false;
    if (needle === "") return true;
    return (
      e.type.toLowerCase().includes(needle) ||
      (e.runId ?? "").toLowerCase().includes(needle) ||
      eventSummary(e).toLowerCase().includes(needle) ||
      JSON.stringify(e.data).toLowerCase().includes(needle)
    );
  });
}

export const shortId = (id: string) => id.slice(0, 8);

/** "2. 1a2b3c4d (subagent) · finished", for a run picker. */
export const runLabel = (run: DebugRun, index: number) =>
  `${index + 1}. ${shortId(run.id)}${run.parentRunId ? " (subagent)" : ""} · ${run.status}`;
