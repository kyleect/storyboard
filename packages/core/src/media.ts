import { mediaKindOf, type Message, type UserMessage } from "./messages.js";

/*
 * Media in a request (files unification design, D14, D15, D40, D54).
 *
 * A message names images and audio by reference. Media is inline in the
 * request of the turn it is attached or read: a user message's `files`, and
 * the files tools returned in a result (`ToolResultMessage.media`). In later
 * turns it is only a text reference, `[Attached: <ref> (type)]`, unless it is
 * kept: by the user's choice for that file, by the agent's `keep` when it
 * read the file, or by the global setting. Only the newest `cap` kept items
 * are inline; the rest fall back to text.
 *
 * A turn is a user message and everything the agent does until the next one.
 * Tool-read media goes to the model in a user message after the turn's tool
 * results (as Pi does for OpenAI-style servers), because a tool message can
 * only hold text.
 */

/** What a model can read, from its `inputModalities`. */
export interface MediaSupport {
  image: boolean;
  audio: boolean;
}

/** What is known about one file: its type and its text, when it has one. */
export interface MediaInfo {
  mediaType: string;
  /** A description or transcript, given to a model that cannot take the file. */
  derivedText?: string | undefined;
}

/** What the harness knows about the media in one request. */
export interface MediaPolicy {
  /** The most kept items from earlier turns that stay inline. */
  cap: number;
  /** Keep media from earlier turns inline when nothing says otherwise. */
  keepDefault: boolean;
  /** The user's choice per file: true keeps it inline, false drops it. */
  choices?: { get(ref: string): boolean | undefined } | undefined;
  /** The kinds the model reads. Undefined: not known, so allowed. */
  support?: MediaSupport | undefined;
  /** A file's media type, or undefined when it is not there any more. */
  info: (ref: string) => MediaInfo | undefined;
}

/** The text that stands for a file, whether or not it is also inline. */
export function attachedLine(
  ref: string,
  info: MediaInfo | undefined,
  support?: MediaSupport,
): string {
  if (!info) return `[Attached: <${ref}> (no longer available)]`;
  const kind = mediaKindOf(info.mediaType);
  if (support && kind && !support[kind]) {
    const what = kind === "image" ? "images" : "audio";
    const text = info.derivedText?.trim();
    return (
      `[Attached: <${ref}> (${info.mediaType}). The model in use cannot view ${what}.` +
      (text ? ` Its text: ${text}` : "") +
      "]"
    );
  }
  return `[Attached: <${ref}> (${info.mediaType})]`;
}

interface Item {
  ref: string;
  /** The agent's choice when it read the file. */
  keep: boolean | undefined;
  current: boolean;
}

/**
 * Applies the inline rule to a request's messages. Every file gets a text
 * line; the ones that stay inline stay in `files`. A turn's tool-read media
 * is added in a user message after its tool results (or at the start of the
 * user message that follows them). Does nothing without a policy.
 */
export function foldMedia(
  messages: readonly Message[],
  policy: MediaPolicy | undefined,
): Message[] {
  if (!policy) return [...messages];

  // The turn is everything after the last user message, a reminder to hand
  // back excepted.
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && m.source !== "reminder") lastUser = i;
  });
  const itemsOf = (m: Message, i: number): Item[] =>
    m.role === "user"
      ? (m.files ?? []).map((ref) => ({
          ref,
          keep: undefined,
          current: i === lastUser,
        }))
      : m.role === "tool"
        ? (m.media ?? []).map((x) => ({
            ref: x.ref,
            keep: x.keep,
            current: i > lastUser,
          }))
        : [];

  // Which items are inline: this turn's, and the newest kept ones before it.
  const inline = new Set<Item>();
  const kept: Item[] = [];
  const all = new Map<number, Item[]>();
  messages.forEach((m, i) => {
    const items = itemsOf(m, i);
    all.set(i, items);
    for (const item of items) {
      const info = policy.info(item.ref);
      const kind = info && mediaKindOf(info.mediaType);
      if (!info || !kind) continue;
      if (policy.support && !policy.support[kind]) continue;
      if (item.current) inline.add(item);
      else if (
        policy.choices?.get(item.ref) ??
        item.keep ??
        policy.keepDefault
      ) {
        kept.push(item);
      }
    }
  });
  for (const item of kept.slice(Math.max(0, kept.length - policy.cap))) {
    inline.add(item);
  }

  const lines = (items: Item[]) =>
    items.map((i) => attachedLine(i.ref, policy.info(i.ref), policy.support));
  const files = (items: Item[]) =>
    items.filter((i) => inline.has(i)).map((i) => i.ref);

  /** The media of the tool results just before, to say in the next message. */
  let pending: Item[] = [];
  const out: Message[] = [];
  const mediaMessage = (items: Item[]): UserMessage => {
    const inlineFiles = files(items);
    return {
      role: "user",
      content: ["Media from the tool results above:", ...lines(items)].join(
        "\n",
      ),
      ...(inlineFiles.length > 0 ? { files: inlineFiles } : {}),
    };
  };
  const flush = (next: Message | undefined) => {
    if (pending.length === 0) return;
    const media = mediaMessage(pending);
    pending = [];
    if (next?.role === "user") return; // merged below
    out.push(media);
  };
  const withPending = (m: UserMessage, own: Item[], carried: Item[]) => {
    const ownLines = lines(own);
    const carriedMessage = carried.length > 0 ? mediaMessage(carried) : null;
    const content = [
      ...(carriedMessage ? [carriedMessage.content] : []),
      ...ownLines,
      ...(m.content !== "" ? [m.content] : []),
    ].join("\n\n");
    const inlineFiles = [...(carriedMessage?.files ?? []), ...files(own)];
    const merged: UserMessage = {
      ...m,
      content: content === "" ? m.content : content,
    };
    if (inlineFiles.length > 0) merged.files = inlineFiles;
    else delete merged.files;
    return merged;
  };

  messages.forEach((m, i) => {
    const items = all.get(i) ?? [];
    if (m.role === "tool") {
      pending.push(...items);
      out.push(m);
      return;
    }
    const carried = pending;
    flush(m);
    if (m.role === "user" && (items.length > 0 || carried.length > 0)) {
      out.push(withPending(m, items, carried));
      return;
    }
    out.push(m);
  });
  flush(undefined);
  return out;
}
