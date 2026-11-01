import type { HarnessEvent } from "./events.js";
import type { ContentBlock } from "./messages.js";

/**
 * Applies one event to an assistant message's content, if the event belongs
 * to that message. Returns a new array when something changed, otherwise the
 * same array. Used to show in-flight messages and to rebuild partial
 * messages from stored events.
 */
export function applyMessageEvent(
  content: readonly ContentBlock[],
  messageId: string,
  event: HarnessEvent,
): readonly ContentBlock[] {
  if (!("messageId" in event.data) || event.data.messageId !== messageId) {
    return content;
  }
  switch (event.type) {
    case "text.delta":
    case "reasoning.delta": {
      const type = event.type === "text.delta" ? "text" : "reasoning";
      const { contentIndex, text } = event.data;
      const next = [...content];
      const block = next[contentIndex];
      next[contentIndex] =
        block && block.type === type
          ? { type, text: block.text + text }
          : { type, text };
      return next;
    }
    case "text.end":
    case "reasoning.end": {
      const type = event.type === "text.end" ? "text" : "reasoning";
      const next = [...content];
      next[event.data.contentIndex] = { type, text: event.data.text };
      return next;
    }
    case "tool.called": {
      const next = [...content];
      next[event.data.contentIndex] = {
        type: "tool_call",
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      };
      return next;
    }
    case "tool.malformed": {
      // Kept in the message only in an agent loop (it has a contentIndex).
      if (event.data.contentIndex === undefined) return content;
      const next = [...content];
      next[event.data.contentIndex] = {
        type: "tool_call",
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments ?? "",
      };
      return next;
    }
    case "message.finished":
      return event.data.message.content;
    default:
      return content;
  }
}

/** Rebuilds a message's content from its events, starting from `initial`. */
export function buildMessageContent(
  events: Iterable<HarnessEvent>,
  messageId: string,
  initial: readonly ContentBlock[] = [],
): ContentBlock[] {
  let content = initial;
  for (const event of events)
    content = applyMessageEvent(content, messageId, event);
  // Holes can only come from a malformed stream; drop them.
  return content.filter((b): b is ContentBlock => b !== undefined);
}
