import type { ChatRequest, ModelAdapter, Usage } from "@harness/core";

/*
 * Auto-rename (auto-rename plan): the title a session gets from its first
 * user message, written by the model or cut down from the message.
 */

/** The longest title, "…" included (decision 7). */
export const TITLE_MAX = 80;

const QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/**
 * Cleans text into a title (plan, step 4): the first non-empty line,
 * trimmed, without surrounding quotes or trailing `.,;:`, with whitespace
 * collapsed, and at most `TITLE_MAX` characters, cut at a word boundary
 * with "…". Empty when nothing usable is left.
 */
export function cleanTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  let title = line;
  for (const [open, close] of QUOTES) {
    if (
      title.length >= open.length + close.length &&
      title.startsWith(open) &&
      title.endsWith(close)
    ) {
      title = title.slice(open.length, title.length - close.length);
      break;
    }
  }
  title = title
    .replace(/[.,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(title);
}

function truncate(title: string): string {
  const chars = [...title];
  if (chars.length <= TITLE_MAX) return title;
  // Room for the "…".
  const room = chars.slice(0, TITLE_MAX - 1).join("");
  const space = room.lastIndexOf(" ");
  const cut = space > 0 ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}

/** What the title call returned. */
export interface ModelTitle {
  text: string;
  usage: Usage | null;
}

/**
 * Asks the model for a title (decision 3): the title prompt as the system
 * message, then the user's message. Reasoning is not kept. Throws when the
 * call fails.
 */
export async function requestTitle(
  model: ModelAdapter,
  options: {
    prompt: string;
    message: string;
    model: string | null;
    reasoningEffort: string | null;
  },
  signal: AbortSignal,
): Promise<ModelTitle> {
  const request: ChatRequest = {
    kind: "chat",
    messages: [
      { role: "system", content: options.prompt },
      { role: "user", content: options.message },
    ],
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
  };
  let text = "";
  let usage: Usage | null = null;
  for await (const chunk of model.stream(request, signal)) {
    if (chunk.type === "text") text += chunk.text;
    else if (chunk.type === "usage") usage = chunk.usage;
  }
  if (signal.aborted) throw new Error("The title call was stopped.");
  return { text, usage };
}
