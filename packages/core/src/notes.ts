import type { Message, ToolResultMessage } from "./messages.js";

/*
 * Approval notes (approval notes design). A note the user typed on an
 * approval prompt is stored on the call's tool result. For the model, the
 * notes of one turn's results become one user message after the turn's last
 * result; when a user message follows, the notes go first in it, so two user
 * messages are never sent in a row because of notes.
 */

const HEADER = "Notes on this turn's tool calls:";

/**
 * The notes message for one turn's tool results, or undefined when none of
 * them has a note. A tool called more than once in the turn is told apart
 * by call ID.
 */
export function formatNotes(
  results: readonly ToolResultMessage[],
): string | undefined {
  const noted = results.filter((r) => r.note);
  if (noted.length === 0) return undefined;
  const calls = new Map<string, number>();
  for (const r of results) calls.set(r.name, (calls.get(r.name) ?? 0) + 1);
  const lines = noted.map((r) => {
    const note = r.note as NonNullable<ToolResultMessage["note"]>;
    const outcome = note.choice === "deny" ? "denied" : "allowed";
    const label =
      (calls.get(r.name) ?? 0) > 1 ? `${outcome}, ${r.callId}` : outcome;
    return `- ${r.name} (${label}): ${note.text}`;
  });
  return [HEADER, ...lines].join("\n");
}

/**
 * Adds each turn's notes message after the turn's tool results, or puts it
 * at the start of the user message that follows them. Other messages are
 * unchanged.
 */
export function foldNotes(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  let turn: ToolResultMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      turn.push(m);
      out.push(m);
      continue;
    }
    const notes = formatNotes(turn);
    turn = [];
    if (notes !== undefined && m.role === "user") {
      out.push({ role: "user", content: `${notes}\n\n${m.content}` });
      continue;
    }
    if (notes !== undefined) out.push({ role: "user", content: notes });
    out.push(m);
  }
  const notes = formatNotes(turn);
  if (notes !== undefined) out.push({ role: "user", content: notes });
  return out;
}
