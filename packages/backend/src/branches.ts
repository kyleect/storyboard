import type { Message } from "@harness/core";
import type { StoredMessage } from "./store.js";

/*
 * Rules about the line of messages a session shows (message editing plan,
 * part B). They work on the top-level messages in order, as
 * `Store.listMessages(id, "top")` returns them.
 */

/** The first line of a message's text, for lists. */
export function messagePreview(
  message: Message | { content?: unknown },
): string {
  const content = (message as { content?: unknown }).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as { type?: string; text?: string }[])
            .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
            .join("")
        : "";
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * The messages the user may edit: their own, written by them. A reminder the
 * harness added, or a subagent's task, is not.
 */
export function isEditable(m: StoredMessage): boolean {
  const message = m.message;
  return (
    message.role === "user" &&
    (message.source === undefined || message.source === "user")
  );
}

/**
 * The messages a branch or a fork may start at (PQ1): a request that ends
 * there is valid. A user message, an edit message and an assistant message
 * without tool calls are; a message with tool calls is not, and neither is a
 * tool result until every call of its group has a result.
 */
export function completePoints(line: readonly StoredMessage[]): Set<string> {
  const points = new Set<string>();
  // The calls of the latest assistant message that have no result yet.
  const open = new Set<string>();
  for (const { id, message } of line) {
    switch (message.role) {
      case "user":
      case "edit":
        if (open.size === 0) points.add(id);
        break;
      case "assistant": {
        const calls = message.content.flatMap((b) =>
          b.type === "tool_call" ? [b.callId] : [],
        );
        if (calls.length === 0) {
          if (open.size === 0) points.add(id);
        } else {
          for (const callId of calls) open.add(callId);
        }
        break;
      }
      case "tool":
        if (open.delete(message.callId) && open.size === 0) points.add(id);
        break;
      case "system":
        break;
    }
  }
  return points;
}

/**
 * The user message that started the turn the line ends in, when that turn
 * has a reply to regenerate; otherwise null. A turn starts at the last user
 * message no run wrote (one sent by the user, not one queued during a run).
 * Its reply is the assistant messages after it. Nothing is offered when the
 * user changed files or data after the reply (an edit message), because
 * regenerating would drop that change, or when no assistant message was
 * written (a turn that failed at once).
 */
export function regenerableTurn(line: readonly StoredMessage[]): string | null {
  let start = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    const m = line[i];
    if (m && m.runId === null && isEditable(m)) {
      start = i;
      break;
    }
  }
  const first = line[start];
  if (!first) return null;
  const after = line.slice(start + 1);
  if (!after.some((m) => m.message.role === "assistant")) return null;
  if (after.some((m) => m.message.role === "edit")) return null;
  return first.id;
}
