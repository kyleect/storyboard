import type { HarnessEvent } from "./events.js";
import type { ContentBlock } from "./messages.js";
/**
 * Applies one event to an assistant message's content, if the event belongs
 * to that message. Returns a new array when something changed, otherwise the
 * same array. Used to show in-flight messages and to rebuild partial
 * messages from stored events.
 */
export declare function applyMessageEvent(content: readonly ContentBlock[], messageId: string, event: HarnessEvent): readonly ContentBlock[];
/** Rebuilds a message's content from its events, starting from `initial`. */
export declare function buildMessageContent(events: Iterable<HarnessEvent>, messageId: string, initial?: readonly ContentBlock[]): ContentBlock[];
