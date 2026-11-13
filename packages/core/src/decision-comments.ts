import type { Message, ToolResultMessage } from "./messages.js";

/*
 * Decision comments. A comment the user typed on an approval prompt, when
 * allowing a call once or denying it, is stored on the call's tool result.
 * For the model, the comments of one turn's results become one user message
 * after the turn's last result; when a user message follows, the comments go
 * first in it, so two user messages are never sent in a row because of
 * comments.
 */

const HEADER = "The user's comments on this turn's tool calls:";

/**
 * The comments message for one turn's tool results, or undefined when none
 * of them has a decision comment. A tool called more than once in the turn
 * is told apart by call ID.
 */
export function formatDecisionComments(
  results: readonly ToolResultMessage[],
): string | undefined {
  const commented = results.filter((r) => r.decisionComment);
  if (commented.length === 0) return undefined;
  const calls = new Map<string, number>();
  for (const r of results) calls.set(r.name, (calls.get(r.name) ?? 0) + 1);
  const lines = commented.map((r) => {
    const comment = r.decisionComment as NonNullable<
      ToolResultMessage["decisionComment"]
    >;
    const outcome = comment.choice === "deny" ? "denied" : "allowed";
    const label =
      (calls.get(r.name) ?? 0) > 1 ? `${outcome}, ${r.callId}` : outcome;
    return `- ${r.name} (${label}): ${comment.text}`;
  });
  return [HEADER, ...lines].join("\n");
}

/**
 * Adds each turn's comments message after the turn's tool results, or puts
 * it at the start of the user message that follows them. Other messages are
 * unchanged.
 */
export function foldDecisionComments(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  let turn: ToolResultMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      turn.push(m);
      out.push(m);
      continue;
    }
    const comments = formatDecisionComments(turn);
    turn = [];
    if (comments !== undefined && m.role === "user") {
      out.push({
        role: "user",
        content: `${comments}\n\n${m.content}`,
        ...(m.files ? { files: m.files } : {}),
      });
      continue;
    }
    if (comments !== undefined) out.push({ role: "user", content: comments });
    out.push(m);
  }
  const comments = formatDecisionComments(turn);
  if (comments !== undefined) out.push({ role: "user", content: comments });
  return out;
}
